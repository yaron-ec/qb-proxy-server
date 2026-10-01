-- 2026-48-followup-meeting-travel.sql
--
-- PERMANENT RULE: a Follow-Up of type 'Meeting' represents a real physical
-- customer meeting and gets the SAME canonical scheduling semantics as a real
-- Appointment (1h duration, busy/blocking, a Driving/Travel Time event) while
-- remaining an independent CRM record (no appointments row is ever created
-- for it) — see lib/booking/followUpMeeting.js and
-- lib/booking/followUpReminders.js. Phone Call/Text/Email/Other follow-ups
-- keep the existing lightweight, free, non-blocking 15-minute reminder.
--
-- followup_calendar_reminders needs two additive columns to track this:
--   representation       'reminder' (the existing 15-min free event) or
--                         'meeting' (a 1h busy main event + a travel event) —
--                         the reconciler diffs against this to know whether a
--                         retype (e.g. Phone Call -> Meeting) must cancel the
--                         old Google event(s) and create new ones (different
--                         deterministic ids) rather than update in place.
--   google_travel_event_id  the Driving/Travel Time event's id, for the
--                         'meeting' representation only — mirrors
--                         appointments.google_travel_event_id. NULL for the
--                         'reminder' representation (no travel event).
--
-- Startup-safe: additive columns only, IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.

ALTER TABLE followup_calendar_reminders
  ADD COLUMN IF NOT EXISTS representation TEXT NOT NULL DEFAULT 'reminder'
    CHECK (representation IN ('reminder', 'meeting')),
  ADD COLUMN IF NOT EXISTS google_travel_event_id TEXT;
