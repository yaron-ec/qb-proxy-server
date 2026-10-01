/* eslint-disable no-undef */
/**
 * websiteAttribution — pure mapping of the attribution the public website
 * sends with every lead (ec-construction-group-website src/lib/attribution.js
 * → server/lib/leads.js#normalizeAttribution) into CRM touches and per-inquiry
 * metadata. No I/O; persistence is lib/marketing/attributionStore.js.
 *
 * Website payload (all optional; absent on leads older than the feature):
 *   attribution: {
 *     v: 2,                       // absent on v1 clients (see below)
 *     first_touch:      touch,    // first landing in this browser (90-day window)
 *     last_touch:       touch,    // v2: last MEANINGFUL (non-direct) landing, kept
 *                                 //     across sessions for 90 days
 *                                 // v1: last landing of the current session
 *     conversion_touch: touch,    // v2: landing of the session that submitted
 *     conversion_page:  '/path',
 *   }
 *   page_url, submission_id, form_id, consent_sms, consent_email, consent_gpc
 *
 *   touch = { landing_page, referrer, utm_source, utm_medium, utm_campaign,
 *             utm_content, utm_term, utm_id, gclid, gbraid, wbraid, msclkid,
 *             fbclid, gad_source, gad_campaignid, captured_at }
 *
 * The CRM re-validates everything (allow-list, lengths, formats) — the
 * website's sanitizing is not trusted. Values that fail validation are
 * dropped, never repaired or invented.
 */
'use strict';

const crypto = require('crypto');
const { classifyTouch } = require('./channelClassifier');

const CTRL = /[\u0000-\u001F\u007F]/g;
function clean(v, max) {
  if (v === undefined || v === null || typeof v === 'object') return null;
  const s = String(v).replace(CTRL, '').trim();
  return s ? s.slice(0, max) : null;
}

const TEXT_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'utm_id'];
const CLICK_KEYS = ['gclid', 'gbraid', 'wbraid', 'msclkid', 'fbclid'];
const GAD_KEYS = ['gad_source', 'gad_campaignid'];
const CLICK_RE = /^[A-Za-z0-9_\-.~+/=]{1,200}$/;
const GAD_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** Fields that define a touch's identity (content_hash) — order matters. */
const IDENTITY_KEYS = ['occurred_at', 'landing_page', 'referrer', ...TEXT_KEYS, ...CLICK_KEYS, ...GAD_KEYS];

function cleanPath(v) {
  const s = clean(v, 500);
  if (!s || !s.startsWith('/') || s.startsWith('//')) return null;
  return s.split(/[?#]/)[0].slice(0, 300) || null;
}

function cleanUrl(v) {
  const s = clean(v, 1000);
  if (!s) return null;
  try {
    const u = new URL(s);
    if (!/^https?:$/.test(u.protocol) || !u.hostname) return null;
    return `${u.protocol}//${u.host}${u.pathname}`.slice(0, 300);
  } catch { return null; }
}

function validIso(v, nowMs) {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const t = Date.parse(v);
  if (!Number.isFinite(t)) return null;
  if (t > nowMs + 5 * 60e3 || t < Date.UTC(2020, 0, 1)) return null;
  return new Date(t).toISOString();
}

/**
 * Normalize one touch. Returns null when it carries no usable evidence at
 * all (not even a landing page). `fallbackAt` is used only when the browser
 * sent no valid timestamp (never earlier than the evidence allows).
 */
function normalizeTouch(raw, { nowMs = Date.now(), fallbackAt = null } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const t = {};
  const lp = cleanPath(raw.landing_page);
  if (lp) t.landing_page = lp;
  const ref = cleanUrl(raw.referrer);
  if (ref) t.referrer = ref;
  for (const k of TEXT_KEYS) { const v = clean(raw[k], 200); if (v) t[k] = v; }
  for (const k of CLICK_KEYS) { const v = clean(raw[k], 200); if (v && CLICK_RE.test(v)) t[k] = v; }
  for (const k of GAD_KEYS) { const v = clean(raw[k], 64); if (v && GAD_RE.test(v)) t[k] = v; }
  if (!Object.keys(t).length) return null;
  const at = validIso(raw.captured_at, nowMs);
  t.occurred_at = at || fallbackAt;
  t.occurred_at_source = at ? 'browser' : 'submission';
  if (!t.occurred_at) return null;

  const c = classifyTouch(t);
  t.channel_code = c.channel_code;
  t.source = c.source;
  t.medium = c.medium;
  t.classifier_version = c.classifier_version;
  t.campaign = t.utm_campaign || null;
  t.campaign_id = t.gad_campaignid || t.utm_id || null;
  t.content_hash = touchHash(t);
  return t;
}

function touchHash(t) {
  const basis = IDENTITY_KEYS.map((k) => [k, t[k] == null ? null : String(t[k])]);
  return crypto.createHash('sha256').update(JSON.stringify(basis)).digest('hex');
}

const isMeaningful = (t) => !!t && t.channel_code !== 'direct';

/**
 * Map a website lead body to { touches: { first, last, conversion }, inquiry }.
 * touches.* are normalized touches or null; `last` is the last MEANINGFUL
 * touch (never Direct). Identical touches share one content_hash, so the
 * store keeps a single row for them.
 */
function mapWebsiteAttribution(body, { now = Date.now(), submittedAt = null } = {}) {
  const nowMs = typeof now === 'number' ? now : Date.parse(now);
  const fallbackAt = submittedAt || new Date(nowMs).toISOString();
  const a = body && typeof body.attribution === 'object' && !Array.isArray(body.attribution) ? body.attribution : {};
  const opts = { nowMs, fallbackAt };
  const first = normalizeTouch(a.first_touch, opts);
  const lastRaw = normalizeTouch(a.last_touch, opts);
  const convRaw = normalizeTouch(a.conversion_touch, opts);
  const isV2 = Number(a.v) >= 2;

  let last;
  let conversion;
  if (isV2) {
    last = isMeaningful(lastRaw) ? lastRaw : null;
    conversion = convRaw || lastRaw || first;
  } else {
    // v1 clients: last_touch was the current session's landing (may be Direct).
    conversion = lastRaw || first;
    last = isMeaningful(lastRaw) ? lastRaw : (isMeaningful(first) ? first : null);
  }

  const conversionPage = cleanPath(a.conversion_page);
  const inquiry = {
    website_lead_id: clean(body && body.id, 100),
    website_submission_id: body && typeof body.submission_id === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(body.submission_id) ? body.submission_id : null,
    page_url: cleanUrl(body && body.page_url),
    conversion_page: conversionPage,
    form_id: (() => { const f = clean(body && body.form_id, 80); return f && /^[A-Za-z0-9:_\-./]+$/.test(f) ? f : null; })(),
    consent_sms: body && body.consent_sms === true,
    consent_email: body && typeof body.consent_email === 'boolean' ? body.consent_email : null,
    consent_gpc: body && typeof body.consent_gpc === 'boolean' ? body.consent_gpc : null,
    payload_version: isV2 ? 2 : (first || lastRaw ? 1 : 0),
  };
  return { touches: { first, last, conversion }, inquiry };
}

module.exports = { mapWebsiteAttribution, normalizeTouch, touchHash, IDENTITY_KEYS };
