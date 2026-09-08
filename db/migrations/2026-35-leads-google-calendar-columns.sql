-- 2026-35-leads-google-calendar-columns.sql
-- Add Google Calendar sync columns to leads table (missing from original migration).
-- The frontend CalendarSyncPanel reads lead.google_calendar_sync_status, but the
-- Railway leads table was missing this column — causing "Sync pending..." to show
-- for ALL leads, even those with fully synced appointments.
-- This migration adds the columns and backfills from synced appointments.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'leads' AND column_name = 'google_calendar_sync_status') THEN
    ALTER TABLE leads ADD COLUMN google_calendar_sync_status VARCHAR DEFAULT 'pending';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'leads' AND column_name = 'google_event_id') THEN
    ALTER TABLE leads ADD COLUMN google_event_id VARCHAR;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'leads' AND column_name = 'google_travel_event_id') THEN
    ALTER TABLE leads ADD COLUMN google_travel_event_id VARCHAR;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'leads' AND column_name = 'last_google_sync') THEN
    ALTER TABLE leads ADD COLUMN last_google_sync TIMESTAMPTZ;
  END IF;
END $$;

-- Backfill: for each lead with a synced appointment, update the lead's calendar sync status
-- Uses the most recent synced appointment per lead
UPDATE leads l
SET google_calendar_sync_status = 'synced',
    google_event_id = latest.google_event_id,
    google_travel_event_id = latest.google_travel_event_id,
    last_google_sync = latest.calendar_synced_at,
    updated_at = NOW()
FROM (
  SELECT DISTINCT ON (lead_id)
    lead_id, google_event_id, google_travel_event_id, calendar_synced_at
  FROM appointments
  WHERE calendar_sync_status = 'synced'
    AND google_event_id IS NOT NULL
  ORDER BY lead_id, calendar_synced_at DESC
) latest
WHERE latest.lead_id = l.id
  AND (l.google_calendar_sync_status IS NULL OR l.google_calendar_sync_status != 'synced');
