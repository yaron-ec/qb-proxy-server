-- Production incident fix (October 2026): a real manual SMS send from Lead
-- Detail (test recipient: Michelle Roitman's existing test lead, consent
-- already on file — not a consent/quiet-hours issue) failed with
--   new row for relation "sms_messages" violates check constraint
--   "sms_messages_status_check"
--
-- Root cause: 2026-63-sms-messaging.sql's sms_messages_status_check only
-- allowed ('queued','sent','delivered','failed','undelivered','received').
-- lib/smsClient.js#sendMessage returns Twilio's own `status` field verbatim
-- from the Message-create response (`status: data.status || 'queued'`), and
-- lib/smsService.js#handleStatusCallback writes Twilio's StatusCallback
-- `MessageStatus` verbatim too — both are the ONLY two write paths for this
-- column (every outbound send — manual compose, booking confirmation, 12h/2h
-- reminders — funnels through smsService.sendSms; every delivery-status
-- update funnels through handleStatusCallback). Neither path invented a
-- status string; both persist whatever Twilio's live API actually returns.
--
-- This installation sends via TWILIO_MESSAGING_SERVICE_SID (A2P campaign —
-- CLAUDE.md's own documented "preferred" config), and Twilio's documented
-- behavior for a Messaging-Service-originated send is that the initial
-- Message-create response status is 'accepted' (Twilio has accepted the API
-- call but has not yet picked a Sender from the pool), NOT 'queued' — 'queued'
-- is the initial state only for a bare TWILIO_FROM send. The very next
-- StatusCallback delivery (fired as the message moves toward the carrier)
-- reports 'sending' as an intermediate state before 'sent'/'delivered'. Both
-- 'accepted' and 'sending' are real, officially documented Twilio Message
-- statuses this integration will see on every single Messaging-Service send
-- — reproduced directly against a migrated disposable Postgres instance
-- before this fix (both INSERT with status='accepted' and UPDATE to
-- status='sending' raised exactly the reported constraint violation).
--
-- Fix: widen the allow-list to the complete, audited set of Message-resource
-- statuses this integration can legitimately receive for plain, two-way,
-- single-recipient SMS/MMS sent via either a Messaging Service or a bare
-- From number, with no Twilio Schedule Send (smsClient.js never sets
-- `SendAt`) and no WhatsApp/channel usage:
--   accepted, queued, sending, sent, delivered, undelivered, failed,
--   canceled, receiving, received
-- Deliberately NOT added: 'read' (channel/WhatsApp read-receipts only —
-- structurally impossible for plain SMS), 'partially_delivered' (multi-
-- recipient broadcast only — this integration always sends to exactly one
-- `To`), 'scheduled' (Twilio's Schedule Send feature — never used here).
-- Adding either of those would be guessing at values nothing in this
-- codebase can ever produce, not auditing real, reachable paths.
--
-- Forward-only, additive, no data rewrite: existing rows keep their current
-- status values (all of which were already within the old allow-list, since
-- the old constraint is exactly what blocked anything outside it from ever
-- being persisted) — this only widens what a FUTURE write may store.
ALTER TABLE sms_messages DROP CONSTRAINT IF EXISTS sms_messages_status_check;
ALTER TABLE sms_messages ADD CONSTRAINT sms_messages_status_check
  CHECK (status IN (
    'accepted', 'queued', 'sending', 'sent', 'delivered', 'undelivered',
    'failed', 'canceled', 'receiving', 'received'
  ));
