/* eslint-disable no-undef */
'use strict';

/**
 * estimateSentDetection.test.js — pure unit coverage for
 * lib/estimateSentDetection.js's classifyQbSentEvidence(), the classifier
 * that decides whether a raw QuickBooks Estimate payload carries reliable
 * evidence it was actually emailed to the customer. The ONE and ONLY
 * confirmed-true case is EmailStatus='EmailSent' with a usable timestamp —
 * every other input, including the two other real QuickBooks EmailStatus
 * values and the "sent with no timestamp" edge case, must report
 * confirmed:false, never a guess.
 */
const test = require('node:test');
const assert = require('node:assert');
const { classifyQbSentEvidence, CONFIRMED_EMAIL_STATUSES } = require('../lib/estimateSentDetection');

test('EmailStatus=EmailSent with DeliveryInfo.DeliveryTime: confirmed, uses the real delivery instant', () => {
  const result = classifyQbSentEvidence({
    EmailStatus: 'EmailSent',
    DeliveryInfo: { DeliveryTime: '2026-11-01T18:30:00.000-07:00' },
    MetaData: { LastUpdatedTime: '2026-11-02T00:00:00.000-07:00' },
  });
  assert.strictEqual(result.confirmed, true);
  assert.strictEqual(result.sentAt, '2026-11-01T18:30:00.000-07:00');
  assert.strictEqual(result.evidence, 'qb_email_status_sent');
  assert.strictEqual(result.emailStatus, 'EmailSent');
});

test('EmailStatus=EmailSent with NO DeliveryInfo but a real MetaData.LastUpdatedTime: confirmed, falls back to that', () => {
  const result = classifyQbSentEvidence({
    EmailStatus: 'EmailSent',
    MetaData: { LastUpdatedTime: '2026-11-02T00:00:00.000-07:00' },
  });
  assert.strictEqual(result.confirmed, true);
  assert.strictEqual(result.sentAt, '2026-11-02T00:00:00.000-07:00');
  assert.strictEqual(result.evidence, 'qb_email_status_sent');
});

test('DeliveryInfo.DeliveryTime takes priority over MetaData.LastUpdatedTime when both are present', () => {
  const result = classifyQbSentEvidence({
    EmailStatus: 'EmailSent',
    DeliveryInfo: { DeliveryTime: '2026-11-01T18:30:00.000-07:00' },
    MetaData: { LastUpdatedTime: '2026-11-05T00:00:00.000-07:00' },
  });
  assert.strictEqual(result.sentAt, '2026-11-01T18:30:00.000-07:00');
});

test('EmailStatus=EmailSent with NO usable timestamp anywhere: NOT confirmed — never invents "now"', () => {
  const result = classifyQbSentEvidence({ EmailStatus: 'EmailSent' });
  assert.strictEqual(result.confirmed, false);
  assert.strictEqual(result.sentAt, null);
  assert.strictEqual(result.evidence, 'email_sent_no_timestamp');
});

test('EmailStatus=NeedToSend: never confirmed, regardless of timestamps present', () => {
  const result = classifyQbSentEvidence({
    EmailStatus: 'NeedToSend',
    DeliveryInfo: { DeliveryTime: '2026-11-01T18:30:00.000-07:00' },
  });
  assert.strictEqual(result.confirmed, false);
  assert.strictEqual(result.sentAt, null);
  assert.strictEqual(result.evidence, 'none');
  assert.strictEqual(result.emailStatus, 'NeedToSend');
});

test('EmailStatus=NotSet: never confirmed', () => {
  const result = classifyQbSentEvidence({ EmailStatus: 'NotSet' });
  assert.strictEqual(result.confirmed, false);
  assert.strictEqual(result.evidence, 'none');
});

test('EmailStatus missing/null/empty estimate object: never confirmed, never throws', () => {
  assert.strictEqual(classifyQbSentEvidence({}).confirmed, false);
  assert.strictEqual(classifyQbSentEvidence(null).confirmed, false);
  assert.strictEqual(classifyQbSentEvidence(undefined).confirmed, false);
  assert.strictEqual(classifyQbSentEvidence({ EmailStatus: null }).confirmed, false);
});

test('an unrecognized/future EmailStatus value (not in the 3 documented values) is never treated as confirmed', () => {
  const result = classifyQbSentEvidence({ EmailStatus: 'SomeFutureStatus', DeliveryInfo: { DeliveryTime: '2026-11-01T00:00:00Z' } });
  assert.strictEqual(result.confirmed, false);
});

test('CONFIRMED_EMAIL_STATUSES contains exactly EmailSent — never creation/import/pending-like values', () => {
  assert.deepStrictEqual([...CONFIRMED_EMAIL_STATUSES], ['EmailSent']);
});

test('the raw handoff_estimates-persisted shape (qb_email_status/qb_email_delivery_time columns, reconstructed as EmailStatus/DeliveryInfo) classifies identically to the live API shape', () => {
  // This is exactly the shape lib/estimateFollowupEngine.js#runAutoEnrollmentScan
  // builds from the two persisted columns.
  const fromDb = classifyQbSentEvidence({
    EmailStatus: 'EmailSent',
    DeliveryInfo: { DeliveryTime: '2026-11-01T18:30:00.000Z' },
  });
  assert.strictEqual(fromDb.confirmed, true);
  assert.strictEqual(fromDb.sentAt, '2026-11-01T18:30:00.000Z');
});
