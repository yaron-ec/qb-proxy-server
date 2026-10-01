/* eslint-disable no-undef */
/**
 * /api/v1/signnow-webhook — SignNow callback receiver (Railway-native).
 *
 * Replaces the Base44 signNowWebhook function. SignNow sends event callbacks
 * here when documents are signed/completed.
 *
 *   GET  /api/v1/signnow-webhook   — Webhook verification (returns 200)
 *   POST /api/v1/signnow-webhook   — Process document completion events
 *
 * Optional secret verification via ?secret=<WEBHOOK_SECRET> query param.
 *
 * When a MAIN CONTRACT (name contains "HIC" or "Home Improvement Contract") is fully signed:
 *   1. Update signnow_documents status → signed
 *   2. Download & save signed PDF to R2
 *   3. Create lead_attachment record
 *   4. Update Lead status → Sold (same transaction as the document status and
 *      the activity; the signing time is signnow_documents.signed_at and the
 *      transition is recorded in lead_status_events)
 *   5. Add activity log entry
 *   7. Send email notifications to Yaron, Michelle, and lead owner
 *
 * Idempotent: skips if document already marked as signed.
 */
'use strict';

const express = require('express');
const router = express.Router();
const notificationRecipients = require('../lib/notificationRecipients');
const companyConfig = require('../lib/companyConfig');

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const SIGNNOW_BASE = process.env.SIGNNOW_API_BASE || 'https://api.signnow.com';

// PRODUCTIZATION PHASE 2: was a hardcoded ['yaron@...', 'michelle@...'] —
// now this installation's configured staff notification recipients (see
// lib/notificationRecipients.js). Resolved per-request below, not at
// module scope, since it depends on company_settings.
//
// The per-lead owner email previously came from a static EC-roster
// rep-name->email map (OWNER_EMAIL_MAP); it now comes directly from the
// owners table (joined in the query below), the authoritative source used
// everywhere else in the app (routes/leads.js's resolveOwnerScope,
// lib/dataAccessRailway.js#resolveOwnerEmail) — no name-guessing, and no
// EC-specific roster baked into this file.

function isMainContract(documentName) {
  if (!documentName) return false;
  const name = documentName.toLowerCase();
  return name.includes('hic') || name.includes('home improvement contract');
}

// GET — Webhook verification
router.get('/', (req, res) => {
  res.type('text').send('SignNow Webhook Active');
});

// POST — Process document completion events
router.post('/', express.json(), async (req, res) => {
  try {
    // Optional secret verification
    if (WEBHOOK_SECRET) {
      const supplied = req.query.secret;
      if (supplied !== WEBHOOK_SECRET) {
        console.warn('[signnow-webhook] Unauthorized: secret mismatch');
        return res.status(401).json({ received: false, error: 'Unauthorized' });
      }
    }

    const payload = req.body || {};
    console.log('[signnow-webhook] Received event:', JSON.stringify(payload).slice(0, 500));

    const eventType = payload.event || payload.type || payload.action || payload.event_type || '';
    const docId = payload.document_id || payload.data?.document_id || payload.meta?.document_id || payload.document?.id || '';

    // SignNow webhook event types (from docs.signnow.com):
    //   document.complete — all required fields filled
    //   document.fieldinvite.signed — a field invite was signed
    //   document.fieldinvite.decline — invite declined (not a completion)
    //   user.document.fieldinvite.signed — user-scoped variant
    const isCompletionEvent = (
      eventType === 'document.complete' ||
      eventType === 'document.fieldinvite.signed' ||
      eventType === 'user.document.fieldinvite.signed' ||
      eventType === 'user.document.complete' ||
      eventType === 'document.update' ||
      eventType === 'invite.update' ||
      (payload.meta?.action === 'done') ||
      (payload.content?.document_status === 'completed')
    );

    if (!isCompletionEvent || !docId) {
      console.log('[signnow-webhook] Ignoring non-completion event or missing doc ID');
      return res.json({ received: true, processed: false });
    }

    const { query, pool } = require('../db/client');
    const signnowClient = require('../lib/signnowClient');
    const r2Client = require('../lib/r2Client');

    // Find matching CRM record
    const docRes = await query('SELECT * FROM signnow_documents WHERE document_id = $1', [docId]);
    const docRecord = docRes.rows[0];

    if (!docRecord) {
      console.log(`[signnow-webhook] No CRM record found for doc ID: ${docId}`);
      return res.json({ received: true, processed: false, reason: 'no_crm_record' });
    }

    // Skip if already processed
    if (docRecord.status === 'signed' && docRecord.pdf_url) {
      console.log(`[signnow-webhook] Already processed: ${docId}`);
      return res.json({ received: true, processed: false, reason: 'already_done' });
    }

    // Check document status via SignNow API
    let snDoc;
    try {
      snDoc = await signnowClient.getDocumentStatus(docId);
    } catch (e) {
      if (e.code === 'SIGNNOW_NOT_CONFIGURED') {
        return res.json({ received: true, processed: false, reason: 'signnow_not_configured' });
      }
      console.error('[signnow-webhook] Failed to fetch doc from SignNow:', e.message);
      return res.json({ received: true, processed: false, reason: 'api_error' });
    }

    const signatures = snDoc.signatures || [];
    const isSigned = signatures.length > 0;

    if (!isSigned) {
      console.log('[signnow-webhook] Document not yet fully signed per API');
      return res.json({ received: true, processed: false, reason: 'not_signed' });
    }

    const signedAt = new Date().toISOString();
    const wasAlreadySigned = docRecord.status === 'signed';

    // ── Download & save the signed PDF to R2 (idempotent) ──────────────────
    let pdfUrl = null;
    let pdfSaved = false;
    if (!docRecord.pdf_url) {
      try {
        const pdfBuffer = await signnowClient.downloadSignedPdf(docId);
        const fileName = `Signed_${(docRecord.document_name || 'Contract').replace(/\.pdf$/i, '')}_${signedAt.split('T')[0]}.pdf`;

        // Check if attachment already exists
        const existingAtt = await query(
          'SELECT file_url FROM lead_attachments WHERE lead_id = $1 AND file_name = $2',
          [docRecord.lead_id, fileName]
        ).catch(() => ({ rows: [] }));

        if (existingAtt.rows[0]) {
          pdfUrl = existingAtt.rows[0].file_url;
          pdfSaved = true;
          console.log(`[signnow-webhook] Attachment already exists for "${fileName}", reusing`);
        } else if (r2Client.isConfigured()) {
          const result = await r2Client.uploadBuffer(pdfBuffer, 'application/pdf', fileName);
          pdfUrl = result.url;
          // Create lead_attachment record
          await query(
            `INSERT INTO lead_attachments (lead_id, file_name, file_url, file_type, uploaded_by)
             VALUES ($1, $2, $3, 'application/pdf', 'SignNow (auto-sync)')`,
            [docRecord.lead_id, fileName, pdfUrl]
          );
          pdfSaved = true;
          console.log(`[signnow-webhook] PDF saved: ${fileName}`);
        }
      } catch (e) {
        console.error('[signnow-webhook] Failed to download/upload PDF:', e.message);
      }
    } else {
      pdfUrl = docRecord.pdf_url;
    }

    // ── Determine if this is a main contract ──────────────────────────────
    const mainContract = isMainContract(docRecord.document_name);
    console.log(`[signnow-webhook] Document "${docRecord.document_name}" isMainContract: ${mainContract}`);

    // ── Document status + lead Sold + activity: ONE transaction ───────────
    // Previously the document was marked 'signed' and an activity claiming
    // "Lead automatically marked as Sold" was written BEFORE an UPDATE that
    // set four leads columns which do not exist (signed_contract_date,
    // signed_contract_document_id, sold_date, sold_by_source). That UPDATE
    // always failed, the error was swallowed (200 to SignNow, so no retry),
    // and the already-'signed' document was skipped on every later delivery.
    // Now only existing columns are written and all three changes commit
    // together, so a failure leaves the document un-signed and a later
    // delivery processes it again. The signing time stays canonical in
    // signnow_documents.signed_at; the Sold transition is recorded by the
    // lead_status_events trigger (change_source 'signnow').
    let lead = null;
    let markedSold = false;
    const tx = await pool.connect();
    try {
      await tx.query('BEGIN');
      await tx.query(
        `SELECT set_config('ec.actor', 'SignNow webhook', true), set_config('ec.change_source', 'signnow', true), set_config('ec.status_reason', $1, true)`,
        [`signnow_document:${docId}`.slice(0, 60)]);
      await tx.query(
        `UPDATE signnow_documents SET status = 'signed', signed_at = COALESCE(signed_at, $1),
         last_status_check = $1, pdf_url = COALESCE(pdf_url, $2), updated_at = NOW()
         WHERE document_id = $3`,
        [signedAt, pdfUrl, docId]
      );
      if (mainContract && docRecord.lead_id) {
        lead = (await tx.query(
          `SELECT l.*, o.email AS owner_email FROM leads l LEFT JOIN owners o ON o.id = l.owner_id WHERE l.id = $1 FOR UPDATE OF l`,
          [docRecord.lead_id]
        )).rows[0] || null;
        if (lead && lead.status !== 'Sold') {
          await tx.query(`UPDATE leads SET status = 'Sold', updated_at = NOW() WHERE id = $1`, [docRecord.lead_id]);
          markedSold = true;
        }
      }
      // Activity log (only on first transition to signed), stating what actually happened.
      if (!wasAlreadySigned) {
        const soldText = !mainContract ? ''
          : markedSold ? ' Lead automatically marked as Sold.'
          : lead ? ' Lead was already Sold.' : '';
        const activityContent = mainContract
          ? `✅ Main contract signed in SignNow: "${docRecord.document_name}".${soldText}${pdfSaved ? ' Signed PDF saved to attachments.' : ''}`
          : `✅ Contract signed in SignNow: "${docRecord.document_name}".${pdfSaved ? ' Signed PDF saved to attachments.' : ''}`;
        await tx.query(
          `INSERT INTO activities (lead_id, type, content, author, source, created_at)
           VALUES ($1, 'note', $2, 'SignNow (auto)', 'manual', $3)`,
          [docRecord.lead_id, activityContent, signedAt]
        );
      }
      await tx.query('COMMIT');
    } catch (e) {
      await tx.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      tx.release();
    }

    // ── Email notification summary ───────────────────────────────────────
    const emailNotification = { attempted: 0, sent: 0, failed: 0 };

    // ── If main contract: notify that the lead was marked Sold ────────────
    if (mainContract && docRecord.lead_id) {
      if (lead && markedSold) {
        console.log(`[signnow-webhook] Lead ${docRecord.lead_id} marked as Sold`);

        // ── Send notifications via Railway EmailService ─────────────────
        const leadName = `${lead.first_name || ''} ${lead.last_name || ''}`.trim();
        const leadAddress = lead.property_address || lead.city || '';
        const projectValue = lead.estimated_value ? `$${Number(lead.estimated_value).toLocaleString()}` : 'N/A';
        const subject = `Contract Signed - Lead Marked as Sold: ${leadName}`;
        const emailBody = [
          `Great news! A contract has been signed and a lead has been automatically marked as Sold.`,
          ``,
          `Lead: ${leadName}`,
          `Address: ${leadAddress}`,
          `Project Value: ${projectValue}`,
          `Contract: ${docRecord.document_name}`,
          `Signed At: ${new Date(signedAt).toLocaleString('en-US', { timeZone: await companyConfig.getTimezone() })}`,
          ``,
          `The lead is now visible in the Deals section of the CRM.`,
        ].join('\n');

        const htmlEmailBody = `<pre style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:15px;line-height:1.6;color:#1A1A2E;white-space:pre-wrap;word-wrap:break-word;">${emailBody.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>`;

        // Build recipient list (this installation's staff recipients + lead owner, deduped).
        // The owners table (joined above) is the authoritative rep->email
        // mapping — no name-guessing needed.
        const recipients = new Set(await notificationRecipients.getAllStaffRecipients());
        if (lead.owner_email) {
          recipients.add(lead.owner_email);
        } else if (lead.assigned_rep && lead.assigned_rep.includes('@')) {
          recipients.add(lead.assigned_rep);
        }

        const recipientList = Array.from(recipients).filter(Boolean);

        // Send via Railway EmailService
        try {
          const emailService = require('../lib/emailService');
          const idempotencyKey = `signnow-webhook:${docId}:${signedAt}`;

          for (const recipient of recipientList) {
            emailNotification.attempted++;
            try {
              await emailService.send({
                to: recipient,
                subject,
                htmlBody: htmlEmailBody,
                idempotencyKey: `${idempotencyKey}:${recipient}`,
                role: 'signnow-webhook',
              });
              emailNotification.sent++;
              console.log(`[signnow-webhook] Notification sent to ${recipient}`);
            } catch (e) {
              emailNotification.failed++;
              console.warn(`[signnow-webhook] Failed to send email to ${recipient}: ${e.message}`);
            }
          }
        } catch (e) {
          console.warn('[signnow-webhook] EmailService unavailable:', e.message);
        }
      } else if (lead?.status === 'Sold') {
        console.log('[signnow-webhook] Lead already Sold, skipping status update');
      }
    }

    console.log(`[signnow-webhook] Successfully processed signed document: ${docId}`);
    res.json({
      received: true,
      processed: true,
      main_contract: mainContract,
      file_url: pdfUrl,
      email_notification: emailNotification,
    });
  } catch (e) {
    console.error('[signnow-webhook] error:', e.message);
    // 200 (unchanged contract with SignNow). Nothing is left half-written: the
    // document/lead/activity transaction rolled back, so the document is not
    // marked 'signed' and the next delivery for it is processed again.
    res.status(200).json({ received: true, processed: false, error: e.message });
  }
});

module.exports = router;