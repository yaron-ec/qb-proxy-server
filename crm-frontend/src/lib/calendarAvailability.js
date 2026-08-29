/**
 * Client-side calendar availability check.
 * Replicates the logic from the checkCalendarConflicts backend function.
 * Uses CRM Lead data (always available) + optional Google Calendar freeBusy API.
 */
import * as railwayLeads from '@/api/railway/leads';

const TZ = 'America/Los_Angeles';
const MICHELLE_EMAIL = 'michelle@ecconstructiongroup.com';
const TOTAL_WINDOW_MINUTES = 120; // 1hr meeting + 1hr buffer

const OWNER_EMAIL_MAP = {
  'yaron':    'yaron@ecconstructiongroup.com',
  'michelle': 'michelle@ecconstructiongroup.com',
  'ethan':    'ethan@ecconstructiongroup.com',
  'micky':    'micky@ecconstructiongroup.com',
  'mickey':   'micky@ecconstructiongroup.com',
  'victoria': 'victoria@ecconstructiongroup.com',
  'sharon':   'sharon@ecconstructiongroup.com',
};

const ALL_SLOTS = [];
for (let h = 8; h <= 18; h++) {
  for (let m = 0; m < 60; m += 30) {
    if (h === 8 && m === 0) continue;
    if (h === 18 && m > 30) continue;
    ALL_SLOTS.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
  }
}

export function resolveOwnerEmail(ownerName) {
  if (!ownerName || typeof ownerName !== 'string') return null;
  const normalized = ownerName.trim().toLowerCase();
  const email = OWNER_EMAIL_MAP[normalized]
    || OWNER_EMAIL_MAP[normalized.split(/\s+/)[0]]
    || `${normalized.split(/\s+/)[0]}@ecconstructiongroup.com`;
  if (email === MICHELLE_EMAIL) return null;
  return email;
}

function laToUtcIso(date, time) {
  const noonUtc = new Date(`${date}T12:00:00Z`);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(noonUtc);
  const pMap = {};
  for (const p of parts) pMap[p.type] = p.value;
  const laHour = parseInt(pMap.hour === '24' ? '0' : pMap.hour);
  const laMin = parseInt(pMap.minute);
  const offsetMinutes = 720 - (laHour * 60 + laMin);
  const [tH, tM] = time.split(':').map(Number);
  const targetUtcMinutes = tH * 60 + tM + offsetMinutes;
  const utcH = Math.floor(targetUtcMinutes / 60) % 24;
  const utcM = targetUtcMinutes % 60;
  const dayOffset = Math.floor(targetUtcMinutes / (60 * 24));
  const baseDate = new Date(`${date}T00:00:00Z`);
  baseDate.setUTCDate(baseDate.getUTCDate() + dayOffset);
  baseDate.setUTCHours(utcH, utcM, 0, 0);
  return baseDate.toISOString();
}

function isoToLaMinutes(isoStr) {
  const date = new Date(isoStr);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date);
  const pMap = {};
  for (const p of parts) pMap[p.type] = p.value;
  return parseInt(pMap.hour === '24' ? '0' : pMap.hour) * 60 + parseInt(pMap.minute);
}

function slotToMinutes(slot) {
  const [h, m] = slot.split(':').map(Number);
  return h * 60 + m;
}

function computeBlockedSlots(busyPeriods) {
  const blocked = new Set();
  for (const slot of ALL_SLOTS) {
    const slotStart = slotToMinutes(slot);
    const slotEnd = slotStart + TOTAL_WINDOW_MINUTES;
    for (const busy of busyPeriods) {
      const busyStart = isoToLaMinutes(busy.start);
      const busyEnd = isoToLaMinutes(busy.end);
      if (busyStart < slotEnd && busyEnd > slotStart) {
        blocked.add(slot);
        break;
      }
    }
  }
  return Array.from(blocked).sort();
}

// Simple in-memory cache
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

/**
 * Returns { blocked_slots: string[], busy_periods: object[] }
 */
export async function getBlockedSlots(date, ownerName, { forceRefresh = false } = {}) {
  const cacheKey = `${ownerName}|${date}`;
  if (!forceRefresh) {
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;
  }

  const ownerEmail = resolveOwnerEmail(ownerName);
  const busyPeriods = [];
  const seen = new Set();

  const addCrmBlock = (timeStr, source) => {
    if (!timeStr) return;
    let normalized = String(timeStr).replace(/\s*(AM|PM)/i, '').trim();
    if (!normalized.includes(':')) normalized = `${normalized}:00`;
    const start = laToUtcIso(date, normalized);
    const end = new Date(new Date(start).getTime() + 2 * 60 * 60 * 1000).toISOString();
    const key = `${start}|${end}`;
    if (!seen.has(key)) { seen.add(key); busyPeriods.push({ calendar: 'crm', source, start, end }); }
  };

  // CRM-based busy periods — get all meetings on this date for this owner
  // We fetch without assigned_rep filter and match by first name to handle
  // both full-name and first-name-only storage formats
  const allLeads = await railwayLeads.list({ limit: 500 }).then(r => r.items || []).catch(() => []);
  const followUps = allLeads.filter(l => l.follow_up_type === 'Meeting' && l.follow_up_date === date);
  const appointments = allLeads.filter(l => l.appointment_date === date);

  // Filter to this owner: match by full name OR first name
  const matchesOwner = (lead) => {
    if (!ownerName) return true;
    const rep = (lead.assigned_rep || '').trim().toLowerCase();
    const owner = ownerName.trim().toLowerCase();
    return rep === owner || rep === owner.split(/\s+/)[0] || owner === rep.split(/\s+/)[0];
  };

  for (const lead of followUps) {
    if (matchesOwner(lead)) addCrmBlock(lead.follow_up_time || lead.appointment_time, 'follow_up');
  }
  for (const lead of appointments) {
    if (matchesOwner(lead)) addCrmBlock(lead.appointment_time, 'appointment');
  }

  // Google Calendar freeBusy is now handled server-side via Railway.
  // Browser-side Google API calls have been removed — CRM data only here.

  const blocked_slots = computeBlockedSlots(busyPeriods);
  const data = { blocked_slots, busy_periods: busyPeriods };
  cache.set(cacheKey, { data, ts: Date.now() });
  return data;
}

/**
 * Validate a single slot. Returns { available, blocked }.
 */
export async function validateSlot(date, time, ownerName, { forceRefresh = false } = {}) {
  if (!time) return { available: true, blocked: false };
  const [h, m] = time.split(':').map(Number);
  if (h < 8 || (h === 8 && m < 30)) return { available: false, blocked: true, reason: 'before_8_30am' };
  const { blocked_slots } = await getBlockedSlots(date, ownerName, { forceRefresh });
  const isBlocked = blocked_slots.includes(time);
  return { available: !isBlocked, blocked: isBlocked };
}