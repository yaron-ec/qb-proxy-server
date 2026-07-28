/* eslint-disable no-undef */
/**
 * Independent alert dispatch. Does NOT depend on Gmail OAuth — a dead
 * refresh token cannot silence these alerts.
 *
 * Channels (in order):
 *   1. Railway-native: structured console.error (Railway captures logs and
 *      can alert on deploy/cron failures). Always active.
 *   2. External: Slack incoming webhook, IF ALERT_SLACK_WEBHOOK_URL is set.
 *   3. External: Twilio SMS for critical alerts, IF TWILIO_* env is set.
 *
 * HONESTY: if no external channel env is configured, we log a clear
 * "ALERT NOT DELIVERED" warning. We do not claim external alerting is
 * working until it has been configured and tested.
 */
'use strict';

async function dispatchAlert({ level, type, message, context = {} }) {
  const ts = new Date().toISOString();
  const payload = { event: 'REMINDER_ALERT', level, type, message, context, ts };

  // 1. Railway-native structured log (always).
  console.error(JSON.stringify(payload));

  // 2. Slack webhook (if configured).
  const slackUrl = process.env.ALERT_SLACK_WEBHOOK_URL;
  if (slackUrl) {
    try {
      await fetch(slackUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: `[EC CRM Reminder] ${level.toUpperCase()} — ${type}\n${message}\n${JSON.stringify(context)}` }),
      });
    } catch (e) {
      console.error(`[alerts] Slack delivery failed: ${e.message}`);
    }
  } else {
    console.error('[alerts] ALERT NOT DELIVERED externally — no ALERT_SLACK_WEBHOOK_URL configured. Relying on Railway-native logs/cron alerts only.');
  }

  // 3. Twilio SMS for critical alerts (if configured).
  const twilioSid = process.env.TWILIO_ACCOUNT_SID;
  const twilioToken = process.env.TWILIO_AUTH_TOKEN;
  const smsTo = process.env.ALERT_SMS_TO;
  const smsFrom = process.env.TWILIO_FROM;
  if (level === 'critical' && twilioSid && twilioToken && smsTo && smsFrom) {
    try {
      const auth = Buffer.from(`${twilioSid}:${twilioToken}`).toString('base64');
      await fetch(`https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`, {
        method: 'POST',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ To: smsTo, From: smsFrom, Body: `[EC CRM] ${type}: ${message}` }).toString(),
      });
    } catch (e) {
      console.error(`[alerts] Twilio SMS delivery failed: ${e.message}`);
    }
  }
}

module.exports = { dispatchAlert };