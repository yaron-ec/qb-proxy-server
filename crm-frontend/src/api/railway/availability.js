/**
 * railway availability — the ONE canonical availability client for the
 * authenticated CRM app (Lead Detail Schedule/Appointment editor, Activity
 * Composer, Call Log). Calls GET /api/v1/availability/:owner/:date, backed by
 * lib/booking/availabilityService.js — the SAME engine the backend booking
 * write path (lib/booking/bookingService.js) checks against. This replaces
 * the old client-side lib/calendarAvailability.js, which scanned lead rows
 * directly with a different (flat, wrong) buffer rule and never read real
 * Google Calendar events or the canonical appointments table — the source of
 * the "UI says available, backend rejects" class of bug.
 *
 * The public, unauthenticated Lead Capture form (New Lead) uses the separate
 * public endpoint via captureRailwayClient.js — same underlying engine,
 * different (no-JWT) transport.
 */
import { apiCall } from './client';

/**
 * getBlockedSlots({ ownerEmail, date, durationMinutes, excludeAppointmentId })
 * -> { date, timezone, duration_minutes, blocked_slots, busy_windows }
 */
export function getBlockedSlots({ ownerEmail, date, durationMinutes, excludeAppointmentId } = {}) {
  const qs = new URLSearchParams();
  if (durationMinutes != null) qs.set('duration_minutes', String(durationMinutes));
  if (excludeAppointmentId) qs.set('exclude_appointment_id', excludeAppointmentId);
  const q = qs.toString();
  return apiCall(`/api/v1/availability/${encodeURIComponent(ownerEmail)}/${encodeURIComponent(date)}${q ? `?${q}` : ''}`, { method: 'GET' });
}

/**
 * validateSlot({ ownerEmail, date, time, durationMinutes, excludeAppointmentId })
 * -> { available, blocked }
 */
export async function validateSlot({ ownerEmail, date, time, durationMinutes, excludeAppointmentId } = {}) {
  if (!time) return { available: true, blocked: false };
  const [h, m] = time.split(':').map(Number);
  if (h < 8 || (h === 8 && m < 30)) return { available: false, blocked: true, reason: 'before_8_30am' };
  const data = await getBlockedSlots({ ownerEmail, date, durationMinutes, excludeAppointmentId });
  const blocked = (data?.blocked_slots || []).includes(time);
  return { available: !blocked, blocked };
}
