'use strict';

/**
 * logAndRespondUnexpectedError — shared "unexpected error" responder.
 *
 * Extracted (November 2026 CRM hardening pass) from the pattern
 * routes/sms.js already established during the October 2026 SMS incident:
 * `routes/mergeLeads.js`, `saleInvoices.js`, `companySettings.js`,
 * `invoices.js`, and `leadQB.js` previously responded `{ error: e.message }`
 * on any unexpected failure — for a raw Postgres driver error, `e.message`
 * IS the literal server-side error text (column/constraint names, etc.),
 * which is never acceptable to hand a client. Full detail goes to
 * console.error only; the client gets one generic, actionable message.
 *
 * Only for a genuine UNEXPECTED exception (a raw DB/driver error reaching
 * an outer catch-all) — never for an expected validation failure that
 * already has its own specific error code/message.
 */
function logAndRespondUnexpectedError(e, res, context) {
  console.error(`[${context}] error:`, { message: e.message, code: e.code, stack: e.stack });
  res.status(500).json({
    error: 'unexpected_error',
    message: 'Something went wrong. Please try again, or contact support if it keeps happening.',
  });
}

module.exports = { logAndRespondUnexpectedError };
