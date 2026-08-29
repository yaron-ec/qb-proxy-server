import { apiCall } from '@/api/railway/client';

/**
 * Global HubSpot sync store — job-based background sync.
 *
 * Flow:
 * 1. startSync() → calls createSyncJob → gets jobId back immediately
 * 2. Polls hubspotSyncBatch every POLL_INTERVAL_MS with jobId
 * 3. Each batch call processes one page of contacts (<20s per call)
 * 4. Continues polling until job.done === true or error
 */

const STORAGE_KEY = 'hs_sync_meta';
const POLL_INTERVAL_MS = 5000;  // poll every 5s
const DEBOUNCE_MS = 2000;

function loadMeta() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch { return {}; }
}
function saveMeta(meta) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(meta)); } catch {}
}

const listeners = new Set();

const state = {
  syncing: false,
  paused: false,
  mode: null,
  progress: null,
  totals: null,
  statusSummary: null,
  unmappedStatuses: [],
  activityProgress: {
    notes: { found: 0, synced: 0, failed: 0 },
    emails: { found: 0, synced: 0, failed: 0 },
    calls: { found: 0, synced: 0, failed: 0 },
    meetings: { found: 0, synced: 0, failed: 0 },
    tasks: { found: 0, synced: 0, failed: 0 },
    deals: { found: 0, synced: 0, failed: 0 },
    quotes: { found: 0, synced: 0, failed: 0 },
  },
  error: null,
  stats: null,
  meta: loadMeta(),
  stage: null,
  jobId: null,
};

let _syncCtx = null;
let _aborted = false;
let _debounceTimer = null;
let _syncLock = false;
let _pollTimer = null;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function notify() { listeners.forEach(fn => fn({ ...state })); }

export function getState() { return { ...state }; }
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function setStats(stats) { state.stats = stats; notify(); }
export function setSyncContext(ctx) { _syncCtx = ctx; }

/** Backfill meta from DB cursor so "Never" disappears on first load. */
export function backfillMetaFromCursor(cursor) {
  if (!cursor) return;
  const meta = loadMeta();
  let changed = false;
  if (cursor.last_successful_sync_at && !meta.lastSuccessfulSyncAt) {
    meta.lastSuccessfulSyncAt = cursor.last_successful_sync_at;
    meta.lastIncrementalAt = cursor.last_successful_sync_at;
    changed = true;
  }
  if (changed) {
    saveMeta(meta);
    state.meta = meta;
    notify();
  }
}

export function startSync(_base44, mode = 'quick') {
  if (_debounceTimer) return;
  _debounceTimer = setTimeout(() => { _debounceTimer = null; }, DEBOUNCE_MS);

  if (_syncLock || state.syncing) {
    console.warn('[SyncStore] Sync already in progress — ignoring duplicate call');
    return;
  }

  _runSync(mode);
}

async function _runSync(mode) {
  _syncLock = true;
  _aborted = false;
  const syncStartMs = Date.now();

  state.syncing = true;
  state.paused = false;
  state.mode = mode;
  state.totals = null;
  state.error = null;
  state.statusSummary = null;
  state.unmappedStatuses = [];
  state.progress = { synced: 0, updated: 0, skipped: 0, activities: 0, pages: 0 };
  state.stage = 'Queuing sync job...';
  state.jobId = null;
  state._globalJobId = _syncCtx ? _syncCtx.addJob(`HubSpot ${mode === 'full' ? 'Full Re-sync' : 'Quick Sync'}`, 'HubSpot') : null;
  if (_syncCtx && state._globalJobId) _syncCtx.startJob(state._globalJobId);
  notify();

  try {
    // Step 1: Create a background job — returns immediately with jobId
    let jobId;
    try {
      const data = await apiCall('/api/v1/sync-jobs', { method: 'POST', body: { mode } });

      if (data.already_running) {
        // Resume polling an existing job
        jobId = data.jobId;
        state.stage = 'Resuming existing sync...';
        state.jobId = jobId;
        notify();
      } else if (!data.success) {
        throw new Error(data.error || 'Failed to create sync job');
      } else {
        jobId = data.jobId;
        state.jobId = jobId;
        state.stage = 'Sync started in background...';
        notify();
      }
    } catch (err) {
      // 504 or network error when creating job — show friendly message
      const isTimeout = err?.response?.status === 504 || err?.message?.includes('504') || err?.message?.includes('timeout');
      if (isTimeout) {
        state.stage = 'Sync is taking longer than expected and continues in the background.';
        state.syncing = false;
        state.error = null;
      } else {
        state.error = err?.response?.data?.error || err.message || 'Failed to start sync';
        state.syncing = false;
        state.stage = 'failed';
      }
      notify();
      _syncLock = false;
      return;
    }

    // Step 2: Poll hubspotSyncBatch until done
    let consecutiveErrors = 0;
    const MAX_ERRORS = 3;

    while (!_aborted) {
      await sleep(POLL_INTERVAL_MS);
      if (_aborted) break;

      try {
        const data = await apiCall('/api/v1/sync-batch', { method: 'POST', body: { jobId } });

        if (data.error && !data.done) {
          consecutiveErrors++;
          console.warn(`[SyncStore] Batch error (${consecutiveErrors}/${MAX_ERRORS}):`, data.error);
          if (consecutiveErrors >= MAX_ERRORS) {
            throw new Error(data.error);
          }
          // Continue polling — transient error
          state.stage = 'Retrying...';
          notify();
          continue;
        }

        consecutiveErrors = 0;

        // Update progress from batch response
        if (data.progress) {
          state.progress = data.progress;
        }

        const processed = (state.progress?.synced || 0) + (state.progress?.updated || 0);
        state.stage = `Processing... ${processed} contacts synced`;

        if (data.sync_results) {
          const sr = data.sync_results;
          state.activityProgress = {
            notes:    { found: sr.notes?.total || 0,    synced: sr.notes?.synced || 0,    failed: sr.notes?.failed || 0 },
            calls:    { found: sr.calls?.total || 0,    synced: sr.calls?.synced || 0,    failed: sr.calls?.failed || 0 },
            emails:   { found: sr.emails?.total || 0,   synced: sr.emails?.synced || 0,   failed: sr.emails?.failed || 0 },
            meetings: { found: sr.meetings?.total || 0, synced: sr.meetings?.synced || 0, failed: sr.meetings?.failed || 0 },
            tasks:    { found: sr.tasks?.total || 0,    synced: sr.tasks?.synced || 0,    failed: sr.tasks?.failed || 0 },
            deals:    { found: sr.deals?.total || 0,    synced: sr.deals?.synced || 0,    failed: sr.deals?.failed || 0 },
            quotes:   { found: 0, synced: 0, failed: 0 },
          };
          if (sr.status_summary) state.statusSummary = sr.status_summary;
          if (sr.unmapped_statuses) state.unmappedStatuses = sr.unmapped_statuses;
        }

        if (_syncCtx && state._globalJobId && state.stats?.total_contacts > 0) {
          const total = state.stats.total_contacts;
          const pct = Math.min(99, Math.round((processed / total) * 100));
          _syncCtx.progressJob(state._globalJobId, pct);
        }

        notify();

        if (data.done) {
          // Sync completed
          const durationMs = Date.now() - syncStartMs;
          state.totals = { ...state.progress };
          state.syncing = false;
          state.paused = false;
          state.stage = 'done';

          if (_syncCtx && state._globalJobId) _syncCtx.completeJob(state._globalJobId);

          // Persist meta
          const now = new Date().toISOString();
          const meta = loadMeta();
          if (mode === 'full') meta.lastFullSyncAt = now;
          meta.lastQuickSyncAt = now;
          meta.lastSuccessfulSyncAt = now;
          meta.lastIncrementalAt = now;
          if (mode === 'full') meta.lastFullAt = now;
          meta.lastImportedCount = state.progress?.synced || 0;
          meta.lastUpdatedCount = state.progress?.updated || 0;
          meta.lastSkippedCount = state.progress?.skipped || 0;
          meta.lastActivitiesCount = state.progress?.activities || 0;
          meta.lastSyncDurationMs = durationMs;
          meta.lastSyncStatus = 'completed';
          saveMeta(meta);
          state.meta = meta;

          notify();
          _syncLock = false;
          return;
        }

      } catch (batchErr) {
        const isTimeout = batchErr?.response?.status === 504 || batchErr?.message?.includes('504');
        if (isTimeout) {
          // Timeout on a single batch is okay — keep polling
          console.warn('[SyncStore] Batch timeout — continuing to poll...');
          state.stage = 'Sync is taking longer than expected and continues in the background.';
          notify();
          continue;
        }

        consecutiveErrors++;
        if (consecutiveErrors >= MAX_ERRORS) {
          throw batchErr;
        }
        console.warn(`[SyncStore] Batch error ${consecutiveErrors}/${MAX_ERRORS}:`, batchErr.message);
        await sleep(3000);
      }
    }

  } catch (err) {
    const isTimeout = err?.response?.status === 504 || err?.message?.includes('504') || err?.message?.includes('timeout');
    const realError = isTimeout
      ? 'Sync is taking longer than expected and continues in the background.'
      : (err?.response?.data?.error || err?.response?.data?.message || err.message || String(err));

    console.error('[SyncStore] Fatal error:', realError);
    state.error = isTimeout ? null : realError;
    state.stage = isTimeout ? 'Sync continues in background...' : 'failed';
    state.syncing = isTimeout ? false : false;

    if (!isTimeout && _syncCtx && state._globalJobId) {
      _syncCtx.failJob(state._globalJobId, realError);
    }

    const now = new Date().toISOString();
    if (!isTimeout) {
      const meta = loadMeta();
      meta.lastFailedSyncAt = now;
      meta.lastSyncStatus = 'failed';
      meta.lastSyncError = realError;
      saveMeta(meta);
      state.meta = meta;
    }

    notify();
  } finally {
    _syncLock = false;
  }
}