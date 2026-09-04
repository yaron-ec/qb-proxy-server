/* eslint-disable no-undef */
/**
 * calendarOutbox — durable outbox for Google Calendar side effects (Phase 2).
 *
 * ENQUEUE (runs inside the booking mutation transaction):
 *   enqueueCreate / enqueueCancel / enqueueUpdate — INSERT calendar_outbox
 *   rows in the SAME client/tx as the appointment mutation. If the tx rolls
 *   back, the outbox rows roll back with it. No Google API is called here.
 *
 * Idempotency key = `cal:{appointment_id}:{slot}:{action}:v{version}`
 *   - slot        = LA date+startHHMM of the appointment (the event's time identity)
 *   - version     = appointments.version (monotonic; increments on every mutation)
 *   - action      = create_main | create_travel | update_main | update_travel |
 *                   cancel_main | cancel_travel
 *   Retrying the SAME logical operation → same key → UNIQUE index + ON CONFLICT
 *   DO NOTHING → no second row. A LATER legitimate operation of the same action
 *   type has a new version (reschedule) or new attempt → new key → allowed.
 *
 * Google event id (deterministic, client-supplied) =
 *   base32hex(sha256("ec|primary|{appointment_id}|{dateYYYYMMDD}|{hhmm}|{kind}"))
 *   main uses startHHMM; travel uses endHHMM. This is the crash-window guard:
 *   a retried create POSTs the same id → 409 → adopt (no duplicate event).
 *
 * PROCESS (worker, separate from any booking tx):
 *   claim()   — SELECT … FOR UPDATE SKIP LOCKED + mark 'processing' + attempts+1,
 *               then COMMIT (no tx held open during the Google network call).
 *   processRow() — call Google idempotently; write google_event_id back to the
 *               appointment on create/update success.
 *   finalizeSynced() / markFailed() — separate short tx to finalize.
 *   reapStuck() — reset 'processing' rows whose lease expired back to 'pending'.
 *
 * Calendar target: GOOGLE_CALENDAR_ID env (default 'primary' = the service
 * account's primary calendar). This REUSES the existing established mapping
 * (EC_CAL_PATH='primary'); it does not invent a new ownership policy.
 */
'use strict';

const crypto = require('crypto');
const googleCalendarClient = require('./googleCalendarClient');

const TZ = 'America/Los_Angeles';
const MICHELLE_EMAIL = 'michelle@ecconstructiongroup.com';
const YARON_EMAIL = 'yaron@ecconstructiongroup.com';
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || 'primary';

const B32 = '0123456789abcdefghijklmnopqrstuv';

function base32hex(buf) {
  let bits = 0, value = 0, out = '';
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function computeGoogleEventId(appointmentId, dateNoDash, hhmm, kind) {
  const input = `ec|primary|${appointmentId}|${dateNoDash}|${hhmm}|${kind}`;
  return base32hex(crypto.createHash('sha256').update(input).digest().slice(0, 16));
}

function isoToLaParts(iso, tz) {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz || TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const pm = {};
  for (const p of parts) pm[p.type] = p.value;
  const date = `${pm.year}-${pm.month}-${pm.day}`;
  const hh = pm.hour === '24' ? '00' : pm.hour;
  return { date, hhmm: `${hh}${pm.minute}`, hhmmColon: `${hh}:${pm.minute}` };
}

// Build the Google event body + deterministic id + slot for a given kind.
// lead/ownerEmail are required for 'main' (attendees/description); for cancel
// they may be null (the body is discarded — cancel uses only slot + google id).
function buildOperation(appointment, lead, ownerEmail, kind) {
  const tz = appointment.timezone || TZ;
  const startParts = isoToLaParts(appointment.start_at, tz);
  const endParts = isoToLaParts(appointment.end_at, tz);
  const dateNoDash = startParts.date.replace(/-/g, '');
  const slot = `${dateNoDash}${startParts.hhmm}`;
  const versionStr = String(appointment.version != null ? appointment.version : 1);
  const clientName = lead ? `${lead.first_name || ''} ${lead.last_name || ''}`.trim() : 'Client';

  if (kind === 'main') {
    const googleEventId = computeGoogleEventId(appointment.id, dateNoDash, startParts.hhmm, 'main');
    const isPhoneCall = lead && lead.follow_up_type === 'Phone Call';
    const attendeeSet = new Set();
    if (lead && lead.email) attendeeSet.add(lead.email);
    if (ownerEmail) attendeeSet.add(ownerEmail);
    attendeeSet.add(MICHELLE_EMAIL);
    attendeeSet.add(YARON_EMAIL);
    const attendees = Array.from(attendeeSet).map(email => ({ email }));
    const location = lead ? [lead.property_address, lead.city].filter(Boolean).join(', ') : '';
    const description = [
      `Client: ${clientName}`,
      lead && lead.phone ? `Phone: ${lead.phone}` : null,
      lead && lead.email ? `Email: ${lead.email}` : null,
      location ? `Address: ${location}` : null,
      lead && lead.project_type ? `Project: ${lead.project_type}` : null,
      '',
      `CRM Appointment ID: ${appointment.id}`,
    ].filter(l => l !== null).join('\n');
    const body = {
      id: googleEventId,
      summary: isPhoneCall ? `Phone Call with ${clientName}` : `Meeting with ${clientName}`,
      description,
      start: { dateTime: `${startParts.date}T${startParts.hhmmColon}:00`, timeZone: tz },
      end: { dateTime: `${endParts.date}T${endParts.hhmmColon}:00`, timeZone: tz },
      ...(location ? { location } : {}),
      attendees,
      guestsCanSeeOtherGuests: false,
      reminders: { useDefault: false, overrides: [
        { method: 'email', minutes: 48 * 60 },
        { method: 'email', minutes: 24 * 60 },
        { method: 'email', minutes: 12 * 60 },
        { method: 'email', minutes: 2 * 60 },
        { method: 'email', minutes: 30 },
      ] },
      extendedProperties: { private: { ec_appointment_id: appointment.id, ec_version: versionStr, ec_kind: 'main', ec_slot: slot } },
    };
    return { body, googleEventId, slot };
  }
  // travel
  const googleEventId = computeGoogleEventId(appointment.id, dateNoDash, endParts.hhmm, 'travel');
  const travelEndIso = new Date(new Date(appointment.end_at).getTime() + 60 * 60 * 1000).toISOString();
  const travelEndParts = isoToLaParts(travelEndIso, tz);
  const body = {
    id: googleEventId,
    summary: 'Driving / Travel Time',
    description: `Travel time after: Meeting with ${clientName}`,
    start: { dateTime: `${endParts.date}T${endParts.hhmmColon}:00`, timeZone: tz },
    end: { dateTime: `${travelEndParts.date}T${travelEndParts.hhmmColon}:00`, timeZone: tz },
    transparency: 'opaque',
    reminders: { useDefault: false, overrides: [] },
    extendedProperties: { private: { ec_appointment_id: appointment.id, ec_version: versionStr, ec_kind: 'travel', ec_slot: slot } },
  };
  return { body, googleEventId, slot };
}

// ── Enqueue (called from inside the booking transaction) ─────────────────────
async function enqueueRow(client, appointment, action, op, version) {
  const idempotencyKey = `cal:${appointment.id}:${op.slot}:${action}:v${version}`;
  const payload = action.startsWith('cancel') ? null : JSON.stringify(op.body);
  await client.query(
    `INSERT INTO calendar_outbox
       (appointment_id, action, slot, version, google_event_id, calendar_id, payload, idempotency_key, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending')
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [appointment.id, action, op.slot, version, op.googleEventId, CALENDAR_ID, payload, idempotencyKey]
  );
}

async function enqueueCreate(client, appointment, lead, ownerEmail, skipTravel) {
  const main = buildOperation(appointment, lead, ownerEmail, 'main');
  await enqueueRow(client, appointment, 'create_main', main, appointment.version);
  if (!skipTravel) {
    const travel = buildOperation(appointment, lead, ownerEmail, 'travel');
    await enqueueRow(client, appointment, 'create_travel', travel, appointment.version);
  }
}

async function enqueueCancel(client, appointment, version) {
  const main = buildOperation(appointment, null, null, 'main');
  const travel = buildOperation(appointment, null, null, 'travel');
  await enqueueRow(client, appointment, 'cancel_main', main, version);
  await enqueueRow(client, appointment, 'cancel_travel', travel, version);
}

async function enqueueUpdate(client, appointment, lead, ownerEmail, version, durationChanged) {
  const main = buildOperation(appointment, lead, ownerEmail, 'main');
  await enqueueRow(client, appointment, 'update_main', main, version);
  if (durationChanged) {
    const travel = buildOperation(appointment, lead, ownerEmail, 'travel');
    await enqueueRow(client, appointment, 'update_travel', travel, version);
  }
}

// ── Worker claim / process / finalize ────────────────────────────────────────
async function claim(pool, workerId, batchSize) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `SELECT * FROM calendar_outbox
       WHERE status IN ('pending','failed')
         AND next_attempt_at <= NOW()
         AND attempts < max_attempts
       ORDER BY created_at
       FOR UPDATE SKIP LOCKED LIMIT $1`,
      [batchSize]
    );
    const ids = r.rows.map(x => x.id);
    if (ids.length) {
      await client.query(
        `UPDATE calendar_outbox
           SET status = 'processing', claimed_by = $1, claimed_at = NOW(),
               attempts = attempts + 1, updated_at = NOW()
         WHERE id = ANY($2::uuid[])`,
        [workerId, ids]
      );
    }
    await client.query('COMMIT');
    return r.rows.map(x => ({ ...x, status: 'processing', attempts: x.attempts + 1 }));
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
    throw e;
  } finally {
    client.release();
  }
}

async function writeGoogleEventId(pool, appointment_id, action, googleEventId) {
  const col = action.endsWith('_travel') ? 'google_travel_event_id' : 'google_event_id';
  await pool.query(
    `UPDATE appointments SET ${col} = $1, calendar_sync_status = 'synced',
            calendar_synced_at = NOW(), updated_at = NOW()
     WHERE id = $2`,
    [googleEventId, appointment_id]
  );
}

async function processRow(pool, row) {
  const calId = row.calendar_id || CALENDAR_ID;
  // DWD impersonation: use the Workspace calendar owner as the JWT subject.
  // GOOGLE_CALENDAR_ID = yaron@ecconstructiongroup.com → impersonate Yaron.
  // This is REQUIRED for create_main (events with attendees + sendUpdates=all);
  // service accounts cannot invite attendees without DWD impersonation.
  // If calId is not an email (e.g., 'primary'), fall back to YARON_EMAIL.
  const subEmail = (calId && calId.includes('@')) ? calId : YARON_EMAIL;
  const token = await googleCalendarClient.getAccessToken(subEmail);
  const payload = row.payload == null ? null
    : (typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload);

  switch (row.action) {
    case 'create_main':
    case 'create_travel': {
      const appt = (await pool.query(
        'SELECT google_event_id, google_travel_event_id FROM appointments WHERE id = $1',
        [row.appointment_id]
      )).rows[0];
      const existing = row.action === 'create_main' ? (appt && appt.google_event_id) : (appt && appt.google_travel_event_id);
      let result;
      if (existing && existing === row.google_event_id) {
        result = { id: existing, alreadyExisted: true };
      } else {
        result = await googleCalendarClient.createOrUpdateEvent(token, calId, payload, row.action === 'create_main');
      }
      await writeGoogleEventId(pool, row.appointment_id, row.action, result.id);
      break;
    }
    case 'update_main':
    case 'update_travel': {
      const result = await googleCalendarClient.updateEvent(token, calId, row.google_event_id, payload);
      await writeGoogleEventId(pool, row.appointment_id, row.action, result.id);
      break;
    }
    case 'cancel_main':
    case 'cancel_travel': {
      await googleCalendarClient.cancelEvent(token, calId, row.google_event_id);
      break;
    }
    default:
      throw new Error('unknown outbox action: ' + row.action);
  }
}

async function finalizeSynced(pool, id) {
  await pool.query(
    `UPDATE calendar_outbox SET status = 'synced', last_error = NULL,
            claimed_by = NULL, claimed_at = NULL, updated_at = NOW()
     WHERE id = $1`,
    [id]
  );
}

async function markFailed(pool, row, err) {
  const isQuota = !!(err && err.isQuota);
  const attempts = row.attempts; // post-claim increment
  const maxAttempts = row.max_attempts || 5;
  // Bounded retries for ALL failures, including quota. Quota/rate-limit uses a
  // longer backoff than ordinary transient failures, but still reaches 'dead'
  // after max_attempts — no infinite retry loop. max_attempts stays meaningful.
  const dead = attempts >= maxAttempts;
  const baseSec = isQuota ? 300 : 30;        // quota base 5m, transient base 30s
  const capSec = isQuota ? 7200 : 1800;       // quota cap 2h, transient cap 30m
  const backoffSec = Math.min(Math.pow(2, Math.max(attempts - 1, 0)) * baseSec, capSec);
  await pool.query(
    `UPDATE calendar_outbox SET status = $1, last_error = $2,
            next_attempt_at = NOW() + ($3 || ' seconds')::interval,
            claimed_by = NULL, claimed_at = NULL, updated_at = NOW()
     WHERE id = $4`,
    [dead ? 'dead' : 'failed', (err && err.message ? String(err.message).substring(0, 500) : 'unknown error'),
     String(backoffSec), row.id]
  );
}

async function reapStuck(pool, leaseMs) {
  const leaseSec = Math.max(1, Math.floor((leaseMs || 60000) / 1000));
  await pool.query(
    `UPDATE calendar_outbox SET status = 'pending', claimed_by = NULL, claimed_at = NULL,
            next_attempt_at = NOW(), updated_at = NOW()
     WHERE status = 'processing' AND claimed_at < NOW() - ($1 || ' seconds')::interval`,
    [String(leaseSec)]
  );
}

async function claimAndProcess(pool, workerId, opts) {
  opts = opts || {};
  const batchSize = opts.batchSize || 10;
  const leaseMs = opts.leaseMs || 60000;
  const rows = await claim(pool, workerId, batchSize);
  let processed = 0;
  for (const row of rows) {
    try {
      await processRow(pool, row);
      await finalizeSynced(pool, row.id);
      processed++;
    } catch (e) {
      await markFailed(pool, row, e);
    }
  }
  return { claimed: rows.length, processed };
}

module.exports = {
  enqueueCreate, enqueueCancel, enqueueUpdate,
  claim, claimAndProcess, processRow, finalizeSynced, markFailed, reapStuck,
  buildOperation, computeGoogleEventId, isoToLaParts,
  CALENDAR_ID,
};