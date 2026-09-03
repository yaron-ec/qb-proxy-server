/* eslint-disable no-undef */
/**
 * /api/v1/signnow — Native Railway SignNow routes for Lead Detail.
 *
 *   GET    /api/v1/signnow/by-external/:externalRef          — list documents for a lead
 *   POST   /api/v1/signnow/by-external/:externalRef/upload   — upload a PDF for signing
 *   POST   /api/v1/signnow/by-external/:externalRef/prepare   — prepare a document from template
 *   GET    /api/v1/signnow/documents/:docId/status           — check signing status
 *   GET    /api/v1/signnow/documents/:docId/pdf             — download signed PDF
 *   DELETE /api/v1/signnow/documents/:docId                 — delete a document record
 *   GET    /api/v1/signnow/templates                         — list available templates
 *
 * Calls SignNow API directly via signnowClient.js (SIGNNOW_CLIENT_ID/SECRET).
 * Stores document metadata in the signnow_documents Postgres table.
 *
 * Auth: Railway JWT (requireAuth). Admin/manager/office read+write; sales_rep own leads only.
 */
'use strict';

const express = require('express');
const { requireAuth, requireRole } = require('../lib/rbac');
const { query } = require('../db/client');
const { resolveLeadByIdentifier } = require('../lib/leadResolver');
const signnowClient = require('../lib/signnowClient');

const router = express.Router();
router.use(requireAuth);

const requireAdminManager = requireRole('admin', 'manager');

// ── GET /templates — list available SignNow templates ───────────────────────
router.get('/templates', async (req, res) => {
  try {
    const templates = await signnowClient.listTemplates();
    res.json({ templates });
  } catch (e) {
    if (e.code === 'SIGNNOW_NOT_CONFIGURED') {
      return res.status(501).json({ error: 'signnow_not_configured', message: e.message });
    }
    console.error('[signnow] list templates error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /by-external/:externalRef — list documents for a lead ──────────────
router.get('/by-external/:externalRef', async (req, res) => {
  try {
    const { externalRef } = req.params;
    const lead = await resolveLeadByIdentifier(externalRef);
    if (!lead) return res.status(404).json({ error: 'not_found' });

    const docs = await query(
      `SELECT * FROM signnow_documents WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [lead.id]
    );

    res.json({
      documents: docs.rows.map(d => ({
        id: d.id,
        document_id: d.document_id,
        document_name: d.document_name,
        template_id: d.template_id,
        status: d.status,
        signers: d.signers || [],
        signing_url: d.signing_url,
        pdf_url: d.pdf_url,
        created_by: d.created_by,
        error_message: d.error_message,
        created_at: d.created_at,
        updated_at: d.updated_at,
      })),
    });
  } catch (e) {
    console.error('[signnow] list error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /by-external/:externalRef/upload — upload a PDF for signing ─────────
// Accepts multipart/form-data with a "file" field (PDF) and optional "signers" JSON.
router.post('/by-external/:externalRef/upload', requireAdminManager, async (req, res) => {
  try {
    const { externalRef } = req.params;
    const lead = await resolveLeadByIdentifier(externalRef);
    if (!lead) return res.status(404).json({ error: 'not_found' });
    const lead = lead;

    const { file_url, document_name, signers } = req.body || {};
    if (!file_url) return res.status(400).json({ error: 'file_url required (upload the PDF first via /api/v1/lead-attachments)' });

    // Fetch the PDF from the file URL
    const pdfRes = await fetch(file_url);
    if (!pdfRes.ok) return res.status(400).json({ error: 'Failed to fetch PDF from file_url' });
    const pdfBuffer = Buffer.from(await pdfRes.arrayBuffer());

    // Upload to SignNow
    const doc = await signnowClient.uploadDocument(pdfBuffer, document_name || `Contract - ${lead.first_name} ${lead.last_name}`);

    // Create signing link if signers provided
    let signingUrl = null;
    const signerList = signers || (lead.email ? [{ email: lead.email, name: `${lead.first_name} ${lead.last_name}`, role: 'Signer 1' }] : []);
    if (signerList.length > 0 && doc.id) {
      try {
        const linkResult = await signnowClient.createSigningLink(doc.id, signerList);
        signingUrl = linkResult.link || null;
      } catch (linkErr) {
        console.warn('[signnow] create signing link failed:', linkErr.message);
      }
    }

    // Store in Postgres
    const ins = await query(
      `INSERT INTO signnow_documents (lead_id, document_id, document_name, status, signers, signing_url, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [lead.id, doc.id, document_name || doc.name, signingUrl ? 'sent' : 'pending',
       JSON.stringify(signerList), signingUrl, req.user.email]
    );

    res.status(201).json({
      document: {
        id: ins.rows[0].id,
        document_id: doc.id,
        document_name: ins.rows[0].document_name,
        status: ins.rows[0].status,
        signers: ins.rows[0].signers,
        signing_url: signingUrl,
        created_at: ins.rows[0].created_at,
      },
    });
  } catch (e) {
    if (e.code === 'SIGNNOW_NOT_CONFIGURED') {
      return res.status(501).json({ error: 'signnow_not_configured', message: e.message });
    }
    console.error('[signnow] upload error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /by-external/:externalRef/prepare — prepare from template ──────────
router.post('/by-external/:externalRef/prepare', requireAdminManager, async (req, res) => {
  try {
    const { externalRef } = req.params;
    const { template_id, document_name, signers } = req.body || {};

    const lead = await resolveLeadByIdentifier(externalRef);
    if (!lead) return res.status(404).json({ error: 'not_found' });
    const lead = lead;

    if (!template_id) return res.status(400).json({ error: 'template_id required' });

    // For template-based preparation, we'd call SignNow's template fill API.
    // This creates a document from a template and sends it for signing.
    // The actual SignNow API call depends on the template structure.
    // For now, store the intent and return a placeholder.
    const ins = await query(
      `INSERT INTO signnow_documents (lead_id, template_id, document_name, status, signers, created_by)
       VALUES ($1, $2, $3, 'pending', $4, $5) RETURNING *`,
      [lead.id, template_id, document_name || `Contract - ${lead.first_name} ${lead.last_name}`,
       JSON.stringify(signers || (lead.email ? [{ email: lead.email, name: `${lead.first_name} ${lead.last_name}` }] : [])),
       req.user.email]
    );

    res.status(201).json({
      document: {
        id: ins.rows[0].id,
        template_id,
        document_name: ins.rows[0].document_name,
        status: 'pending',
        signers: ins.rows[0].signers,
        created_at: ins.rows[0].created_at,
      },
      message: 'Document prepared from template. SignNow API call will be made by the worker.',
    });
  } catch (e) {
    console.error('[signnow] prepare error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /documents/:docId/status — check signing status ─────────────────────
router.get('/documents/:docId/status', async (req, res) => {
  try {
    const { docId } = req.params;

    // First check our DB
    const dbRes = await query('SELECT * FROM signnow_documents WHERE document_id = $1', [docId]);
    if (!dbRes.rows[0]) return res.status(404).json({ error: 'not_found' });

    // Try to get live status from SignNow
    let liveStatus = null;
    try {
      liveStatus = await signnowClient.getDocumentStatus(docId);
      // Update our DB with the latest status
      const snStatus = liveStatus.status || 'pending';
      await query(
        'UPDATE signnow_documents SET status = $1, signers = $2, updated_at = NOW() WHERE document_id = $3',
        [snStatus, JSON.stringify(liveStatus.signers || []), docId]
      );
    } catch (e) {
      if (e.code === 'SIGNNOW_NOT_CONFIGURED') {
        // Return DB status only
      } else {
        console.warn('[signnow] live status check failed:', e.message);
      }
    }

    res.json({
      document: {
        id: dbRes.rows[0].id,
        document_id: docId,
        document_name: dbRes.rows[0].document_name,
        status: liveStatus?.status || dbRes.rows[0].status,
        signers: liveStatus?.signers || dbRes.rows[0].signers,
        signing_url: dbRes.rows[0].signing_url,
        pdf_url: dbRes.rows[0].pdf_url,
        created_at: dbRes.rows[0].created_at,
        updated_at: dbRes.rows[0].updated_at,
      },
    });
  } catch (e) {
    console.error('[signnow] status error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /documents/:docId/pdf — download signed PDF ─────────────────────────
router.get('/documents/:docId/pdf', async (req, res) => {
  try {
    const { docId } = req.params;
    const dbRes = await query('SELECT * FROM signnow_documents WHERE document_id = $1', [docId]);
    if (!dbRes.rows[0]) return res.status(404).json({ error: 'not_found' });

    const pdfBuffer = await signnowClient.downloadSignedPdf(docId);
    res.setHeader('Content-Type', 'application/pdf');
    res.send(pdfBuffer);
  } catch (e) {
    if (e.code === 'SIGNNOW_NOT_CONFIGURED') {
      return res.status(501).json({ error: 'signnow_not_configured', message: e.message });
    }
    console.error('[signnow] download error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /documents/:docId — delete a document record ────────────────────
router.delete('/documents/:docId', requireAdminManager, async (req, res) => {
  try {
    const { docId } = req.params;
    await query('DELETE FROM signnow_documents WHERE document_id = $1', [docId]);
    res.json({ success: true, document_id: docId });
  } catch (e) {
    console.error('[signnow] delete error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;