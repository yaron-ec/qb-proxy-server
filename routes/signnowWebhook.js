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
 *   4. Update Lead status → Sold
 *   5. Save signed_contract_date, sold_date, sold_by_source
 *   6. Add activity log entry
 *   7. Send email notifications to Yaron, Michelle, and lead owner
 *
 * Idempotent: skips if document already marked as signed.
 */
'use strict';

const express = require('express');
const router = express.Router();

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const SIGNNOW_BASE = process.env.SIGNNOW_API_BASE || 'https://api.signnow.com';

const ALWAYS_NOTIFY = ['yaron@ecconstructiongroup.com', 'michelle@ecconstructiongroup.com'];

const OWNER_EMAIL_MAP = {
  'Yaron': 'yaron@ecconstructiongroup.com',
  'Yaron Drilevich': 'yaron@ecconstructiongroup.com',
  'Mickey': 'mickey@ecconstructiongroup.com',
  'Mickey Gad': 'mickey@ecconstructiongroup.com',
  'Victoria': 'victoria@ecconstructiongroup.com',
  'Michelle': 'michelle@ecconstructiongroup.com',
};

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

    const isCompletionEvent = (
      eventType === 'document.complete' ||
      eventType === 'document.update' ||
      eventType === 'invite.update' ||
      (payload.meta?.action === 'done') ||
      (payload.content?.document_status === 'completed')
    );

    if (!isCompletionEvent || !docId) {
      console.log('[signnow-webhook] Ignoring non-completion event or missing doc ID');
      return res.json({ received: true, processed: false });
    }

    const { query } = require('../db/client');
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

    // ── Update signnow_documents record ──────────────────────────────────
    await query(
      `UPDATE signnow_documents SET status = 'signed', signed_at = COALESCE(signed_at, $1),
       last_status_check = $1, pdf_url = COALESCE(pdf_url, $2), updated_at = NOW()
       WHERE document_id = $3`,
      [signedAt, pdfUrl, docId]
    );

    // ── Determine if this is a main contract ──────────────────────────────
    const mainContract = isMainContract(docRecord.document_name);
    console.log(`[signnow-webhook] Document "${docRecord.document_name}" isMainContract: ${mainContract}`);

    // ── Activity log (only on first transition to signed) ─────────────────
    if (!wasAlreadySigned) {
      const activityContent = mainContract
        ? `✅ Main contract signed in SignNow: "${docRecord.document_name}". Lead automatically marked as Sold.${pdfSaved ? ' Signed PDF saved to attachments.' : ''}`
        : `✅ Contract signed in SignNow: "${docRecord.document_name}".${pdfSaved ? ' Signed PDF saved to attachments.' : ''}`;

      await query(
        `INSERT INTO activities (lead_id, type, content, author, source, created_at)
         VALUES ($1, 'note', $2, 'SignNow (auto)', 'manual', $3)`,
        [docRecord.lead_id, activityContent, signedAt]
      );
    }

    // ── Email notification summary ───────────────────────────────────────
    const emailNotification = { attempted: 0, sent: 0, failed: 0 };

    // ── If main contract: mark lead as Sold ───────────────────────────────
    if (mainContract && docRecord.lead_id) {
      const leadRes = await query('SELECT * FROM leads WHERE id = $1', [docRecord.lead_id]);
      const lead = leadRes.rows[0];

      if (lead && lead.status !== 'Sold') {
        await query(
          `UPDATE leads SET status = 'Sold', signed_contract_date = $1,
           signed_contract_document_id = $2, sold_date = $1, sold_by_source = 'SignNow',
           updated_at = NOW() WHERE id = $3`,
          [signedAt, docId, docRecord.lead_id]
        );
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
          `Signed At: ${new Date(signedAt).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })}`,
          ``,
          `The lead is now visible in the Deals section of the CRM.`,
        ].join('\n');

        const htmlEmailBody = `<pre style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:15px;line-height:1.6;color:#1A1A2E;white-space:pre-wrap;word-wrap:break-word;">${emailBody.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>`;

        // Build recipient list (Yaron + Michelle + lead owner, deduped)
        const recipients = new Set(ALWAYS_NOTIFY);
        if (lead.assigned_rep) {
          const ownerEmail = OWNER_EMAIL_MAP[lead.assigned_rep] || (lead.assigned_rep.includes('@') ? lead.assigned_rep : null);
          if (ownerEmail) recipients.add(ownerEmail);
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
    // Return 200 to prevent retries — the document will be picked up by status polling
    res.status(200).json({ received: true, processed: false, error: e.message });
  }
});

module.exports = router;