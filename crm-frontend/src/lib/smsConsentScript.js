// smsConsentScript — the ONE place the New Lead intake SMS-consent checkbox
// label + representative disclosure script live (never duplicated at a call
// site). Shown in pages/LeadCapture.jsx's Appointment step, only when an
// appointment is actually being booked — see lib/captureValidation.js's
// server-side mirror of that same rule.
export const SMS_CONSENT_CHECKBOX_LABEL =
  'I confirmed with the customer that they agree to receive SMS appointment confirmations, reminders, and appointment-related messages from EC Construction Group.';

// Read (or closely paraphrase) to the customer BEFORE checking the box.
// Covers: company identity, purpose, frequency, rates, and STOP/HELP.
export const SMS_CONSENT_REP_SCRIPT =
  '"Before I confirm your appointment, I\'d like to send you text updates from EC Construction Group — a confirmation now, plus reminders before your visit. These are appointment-related messages only, not marketing, usually just a few texts per appointment. Message and data rates may apply. You can reply STOP at any time to stop these texts, or HELP for help. Is that okay with you?"';
