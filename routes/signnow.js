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
const fieldMapping = require('../lib/signnowFieldMapping');
const { requireModuleEnabled } = require('../lib/moduleGate');

const router = express.Router();
router.use(requireAuth);

const requireAdminManager = requireRole('admin', 'manager');

// PRODUCTIZATION PHASE 2: every route except /status is gated on
// enabled_modules.signnow — /status stays reachable so the admin settings
// panel can always show this installation's actual state (including
// "disabled"), rather than a 404 that looks like a broken page.
router.use((req, res, next) => (req.path === '/status' ? next() : requireModuleEnabled('signnow')(req, res, next)));

// ── GET /status — SignNow connection status ──────────────────────────────────
router.get('/status', async (req, res) => {
  try {
    const authMethod = signnowClient.getAuthMethod();

    // API Key mode — verify the API Key works by calling a SignNow endpoint
    if (authMethod === 'api_key') {
      try {
        const userData = await signnowClient.verifyApiKey();
        return res.json({
          connected: true,
          auth_method: 'api_key',
          name: userData.full_name || userData.first_name || 'API Key',
          email: userData.email || null,
        });
      } catch (e) {
        return res.json({
          connected: false,
          auth_method: 'api_key',
          error: e.code === 'SIGNNOW_AUTH_FAILED' ? 'auth_failed' : 'error',
          message: e.message,
          signnow_error_code: e.signnowErrorCode || null,
        });
      }
    }

    // Password grant mode — check for stored credentials
    const credentialStore = require('../lib/integrationCredentialStore');
    const SIGNNOW_ENV = process.env.SIGNNOW_ENVIRONMENT || 'production';

    let dbCred = null;
    try {
      dbCred = await credentialStore.loadActiveCredential({
        provider: 'signnow',
        credentialType: 'password',
        environment: SIGNNOW_ENV,
      });
    } catch (e) { /* store may not be configured */ }

    const hasDbCreds = !!(dbCred && dbCred.payload && dbCred.payload.username);
    const hasEnvCreds = !!(process.env.SIGNNOW_USERNAME && process.env.SIGNNOW_PASSWORD);

    if (!hasDbCreds && !hasEnvCreds) {
      return res.json({ connected: false, auth_method: 'password_grant' });
    }

    // Verify the connection by attempting to get an access token
    try {
      await signnowClient.getAccessToken();
      const username = hasDbCreds ? dbCred.payload.username : process.env.SIGNNOW_USERNAME;
      res.json({
        connected: true,
        auth_method: 'password_grant',
        name: username,
        email: username.includes('@') ? username : null,
        username,
      });
    } catch (e) {
      if (e.code === 'SIGNNOW_NOT_CONFIGURED') {
        return res.json({ connected: false, auth_method: 'password_grant' });
      }
      res.json({
        connected: false,
        auth_method: 'password_grant',
        error: e.code === 'SIGNNOW_NOT_APP_OWNER' ? 'not_app_owner' : 'auth_failed',
        message: e.message,
        signnow_error_code: e.signnowErrorCode || null,
      });
    }
  } catch (e) {
    console.error('[signnow] status error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /connect — validate and store SignNow credentials (admin/manager only)
//
// API KEY mode: If SIGNNOW_API_KEY is set in the environment, this route just
// verifies the API Key works (no username/password needed). The request body
// is ignored — the API Key is in the environment, not the request.
//
// PASSWORD GRANT mode: Verifies credentials by attempting an OAuth2 token
// exchange BEFORE storing. Invalid credentials return 401 (real auth error).
// Password is NEVER returned in any response, log, or activity.
router.post('/connect', requireAdminManager, async (req, res) => {
  try {
    const authMethod = signnowClient.getAuthMethod();

    // API Key mode — verify the key, no username/password needed
    if (authMethod === 'api_key') {
      try {
        const userData = await signnowClient.verifyApiKey();
        return res.json({
          success: true,
          auth_method: 'api_key',
          name: userData.full_name || userData.first_name || 'API Key',
          email: userData.email || null,
        });
      } catch (e) {
        const status = e.status || 401;
        return res.status(status).json({
          success: false,
          auth_method: 'api_key',
          error: e.code === 'SIGNNOW_AUTH_FAILED' ? 'auth_failed' : 'error',
          message: e.message,
          signnow_error_code: e.signnowErrorCode || null,
        });
      }
    }

    // Password grant mode — verify and store user credentials
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'username and password required' });
    }

    // Verify credentials by attempting a token exchange (does NOT store)
    try {
      await signnowClient.verifyCredentials(username, password);
    } catch (e) {
      if (e.code === 'SIGNNOW_NOT_CONFIGURED') {
        return res.status(501).json({ success: false, error: 'signnow_not_configured', message: e.message });
      }
      const status = e.status || 401;
      return res.status(status).json({
        success: false,
        auth_method: 'password_grant',
        error: e.code === 'SIGNNOW_NOT_APP_OWNER' ? 'not_app_owner' : 'auth_failed',
        message: e.message,
        signnow_error_code: e.signnowErrorCode || null,
      });
    }

    // Store credentials securely in the encrypted credential store
    const credentialStore = require('../lib/integrationCredentialStore');
    const SIGNNOW_ENV = process.env.SIGNNOW_ENVIRONMENT || 'production';
    await credentialStore.saveCredential({
      provider: 'signnow',
      credentialType: 'password',
      environment: SIGNNOW_ENV,
      accountIdentifier: username,
      displayName: username,
      status: 'connected',
      payload: { username, password },
    });

    signnowClient.clearTokenCache();

    res.json({ success: true, auth_method: 'password_grant', name: username, email: username.includes('@') ? username : null });
  } catch (e) {
    console.error('[signnow] connect error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── POST /disconnect — clear stored SignNow credentials (admin/manager only)
router.post('/disconnect', requireAdminManager, async (req, res) => {
  try {
    const credentialStore = require('../lib/integrationCredentialStore');
    const SIGNNOW_ENV = process.env.SIGNNOW_ENVIRONMENT || 'production';
    await credentialStore.deleteCredentials({
      provider: 'signnow',
      credentialType: 'password',
      environment: SIGNNOW_ENV,
    });

    // Clear the token cache
    signnowClient.clearTokenCache();

    res.json({ success: true });
  } catch (e) {
    console.error('[signnow] disconnect error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── GET /templates — list available SignNow templates ───────────────────────
router.get('/templates', async (req, res) => {
  try {
    const [templates, userInfo] = await Promise.all([
      signnowClient.listTemplates(),
      signnowClient.getUserInfo().catch(() => null),
    ]);
    res.json({ templates, account_email: userInfo?.email || null });
  } catch (e) {
    if (e.code === 'SIGNNOW_NOT_CONFIGURED') {
      return res.status(501).json({ error: 'signnow_not_configured', message: e.message });
    }
    console.error('[signnow] list templates error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /crm-sources — list CRM fields available for template mapping ──────
router.get('/crm-sources', requireAdminManager, async (req, res) => {
  res.json({ sources: fieldMapping.listCrmSources() });
});

// ── GET /field-mappings/:templateId — current mapping config for a template,
//    PLUS (best-effort) the document's live field names, read from the most
//    recently prepared document that used this template — so the admin UI
//    can show real field names to map against without guessing. If no
//    document has been prepared from this template yet, live_fields is empty
//    and the admin can still save mappings once field names are known (e.g.
//    from the SignNow template editor itself).
router.get('/field-mappings/:templateId', requireAdminManager, async (req, res) => {
  try {
    const { templateId } = req.params;
    const mappings = await fieldMapping.getMappingsForTemplate(templateId);

    let liveFields = [];
    let liveFieldsError = null;
    try {
      const recent = await query(
        `SELECT document_id FROM signnow_documents WHERE template_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [templateId]
      );
      if (recent.rows[0]?.document_id) {
        const live = await signnowClient.getDocumentFields(recent.rows[0].document_id);
        liveFields = live.fields;
      }
    } catch (e) {
      liveFieldsError = e.code === 'SIGNNOW_NOT_CONFIGURED' ? 'signnow_not_configured' : e.message;
    }

    res.json({ template_id: templateId, mappings, live_fields: liveFields, live_fields_error: liveFieldsError });
  } catch (e) {
    console.error('[signnow] get field-mappings error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── PUT /field-mappings/:templateId — replace a template's mapping config ──
// Body: { mappings: [{ signnow_field_name, field_label, crm_source, required }] }
router.put('/field-mappings/:templateId', requireAdminManager, async (req, res) => {
  try {
    const { templateId } = req.params;
    const { mappings } = req.body || {};
    const saved = await fieldMapping.setMappingsForTemplate(templateId, mappings);
    res.json({ template_id: templateId, mappings: saved });
  } catch (e) {
    res.status(400).json({ error: e.message });
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

    const { file_url, document_name, signers, send_invite } = req.body || {};
    if (!file_url) return res.status(400).json({ error: 'file_url required (upload the PDF first via /api/v1/lead-attachments)' });

    // Fetch the PDF from the file URL
    const pdfRes = await fetch(file_url);
    if (!pdfRes.ok) return res.status(400).json({ error: 'Failed to fetch PDF from file_url' });
    const pdfBuffer = Buffer.from(await pdfRes.arrayBuffer());

    // Upload to SignNow
    const doc = await signnowClient.uploadDocument(pdfBuffer, document_name || `Contract - ${lead.first_name} ${lead.last_name}`);

    // Send field invite ONLY when explicitly requested (POST /document/{docId}/invite)
    // — never implied by upload itself. Defaults to false: never auto-send.
    let inviteSent = false;
    const signerList = signers || (lead.email ? [{ email: lead.email, name: `${lead.first_name} ${lead.last_name}`, role: 'Signer 1' }] : []);
    if (send_invite === true && signerList.length > 0 && doc.id) {
      try {
        const userInfo = await signnowClient.getUserInfo().catch(() => null);
        const fromEmail = userInfo?.email || '';
        if (!fromEmail) {
          console.warn('[signnow] Could not determine SignNow account email for invite sender');
        } else {
          await signnowClient.sendInvite(doc.id, signerList, fromEmail);
          inviteSent = true;
        }
      } catch (inviteErr) {
        console.warn('[signnow] send invite failed:', inviteErr.message);
      }
    }

    // Store in Postgres (signing_url is null — field invite sends email, not a direct link)
    const ins = await query(
      `INSERT INTO signnow_documents (lead_id, document_id, document_name, status, signers, signing_url, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [lead.id, doc.id, document_name || doc.name, inviteSent ? 'sent' : 'pending',
       JSON.stringify(signerList), null, req.user.email]
    );

    res.status(201).json({
      document: {
        id: ins.rows[0].id,
        document_id: doc.id,
        document_name: ins.rows[0].document_name,
        status: ins.rows[0].status,
        signers: ins.rows[0].signers,
        signing_url: null,
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

// ── POST /by-external/:externalRef/prepare — create contract from template ────
// Creates a NEW COPY of the SignNow template (original is never modified).
// Auto-names: "[Customer Name] - [Template Name]"
// Idempotency: rejects if a pending/sent document from the same template exists.
router.post('/by-external/:externalRef/prepare', requireAdminManager, async (req, res) => {
  try {
    const { externalRef } = req.params;
    const { template_id, template_name, document_name, signers, send_invite, deal_id } = req.body || {};

    const lead = await resolveLeadByIdentifier(externalRef);
    if (!lead) return res.status(404).json({ error: 'not_found' });

    if (!template_id) return res.status(400).json({ error: 'template_id required' });

    // Optional Deal context (e.g. for a contract/project-amount field) — only
    // ever the CALLER'S OWN lead's deal, never an arbitrary deal_id, so this
    // can never pull another customer's project amount into this contract.
    let deal = null;
    if (deal_id) {
      const dealRes = await query('SELECT * FROM deals WHERE id = $1 AND lead_id = $2', [deal_id, lead.id]);
      deal = dealRes.rows[0] || null;
    }

    // CRM STABILITY PHASE (Section A2/A4): pre-flight validation against this
    // template's configured field mappings, BEFORE any SignNow API call —
    // "the CRM must identify exactly what is missing BEFORE creating a
    // malformed contract." A template with no mappings configured yet has
    // nothing to validate (this is purely additive; existing templates keep
    // working exactly as before until an admin configures mappings for them).
    const mappings = await fieldMapping.getMappingsForTemplate(template_id);
    const { missing, resolved } = fieldMapping.resolveMappingValues(mappings, { lead, deal });
    if (missing.length > 0) {
      return res.status(422).json({
        error: 'missing_required_fields',
        message: `Cannot prepare ${template_name || 'contract'}: ${missing.map((m) => `${m.field_label} is missing`).join('. ')}.`,
        missing,
      });
    }

    // Idempotency: check for existing non-terminal document from this template
    const existing = await query(
      `SELECT * FROM signnow_documents
       WHERE lead_id = $1 AND template_id = $2
       AND status NOT IN ('completed', 'voided', 'error')
       ORDER BY created_at DESC LIMIT 1`,
      [lead.id, template_id]
    );
    if (existing.rows[0]) {
      return res.status(409).json({
        error: 'duplicate',
        message: 'A pending contract from this template already exists for this lead.',
        document: existing.rows[0],
      });
    }

    // Auto-name: [Customer Name] - [Template Name]
    const customerName = `${lead.first_name || ''} ${lead.last_name || ''}`.trim() || 'Customer';
    const templateName = template_name || 'Contract';
    const finalDocName = document_name || `${customerName} - ${templateName}`;

    // Create a signable document from the template (POST /template/{template_id}/copy)
    // The original template is NEVER modified — only copied.
    let docId = null;
    let inviteSent = false;
    let prefilledCount = 0;
    let prefillWarning = null;
    try {
      const docResult = await signnowClient.createDocumentFromTemplate(template_id, finalDocName);
      docId = docResult.id;

      // CRM STABILITY PHASE (Section A4/A5): populate the copy's TEXT fields
      // from CRM data via the configured mapping, BEFORE any invite is sent
      // (this runs regardless of send_invite — populating fields is never
      // the same action as sending, and never implies it). Must read the
      // COPY's own fields/roles here, never the template's — SignNow assigns
      // a copy its own field/role IDs, distinct from the template's. This is
      // entirely best-effort: a prefill failure never blocks document
      // creation or /prepare's success — the user can still fill the
      // document manually exactly as before this feature existed.
      if (resolved.length > 0) {
        try {
          const live = await signnowClient.getDocumentFields(docId);
          const liveNames = new Set(live.fields.map((f) => f.name));
          const toPrefill = resolved
            .filter((r) => r.value && liveNames.has(r.signnow_field_name))
            .map((r) => ({ field_name: r.signnow_field_name, prefilled_text: r.value }));
          if (toPrefill.length > 0) {
            await signnowClient.prefillTexts(docId, toPrefill);
            prefilledCount = toPrefill.length;
          }
        } catch (prefillErr) {
          console.warn('[signnow] prepare: prefill-texts failed (non-fatal):', prefillErr.message);
          prefillWarning = prefillErr.message;
        }
      }

      // Send field invite ONLY when explicitly requested — never implied by
      // creation. Defaults to false: preparing a contract must never auto-send
      // it (see POST /documents/:docId/send, the explicit, separate action).
      const shouldSend = send_invite === true;
      const signerList = signers || (lead.email ? [{ email: lead.email, name: customerName, role: 'Signer 1' }] : []);
      if (shouldSend && signerList.length > 0 && docId) {
        const userInfo = await signnowClient.getUserInfo().catch(() => null);
        const fromEmail = userInfo?.email || '';
        if (fromEmail) {
          await signnowClient.sendInvite(docId, signerList, fromEmail);
          inviteSent = true;
        }
      }
    } catch (e) {
      if (e.code === 'SIGNNOW_NOT_CONFIGURED') {
        return res.status(501).json({ error: 'signnow_not_configured', message: e.message });
      }
      console.error('[signnow] prepare: create from template failed:', e.message);
      return res.status(500).json({ error: e.message });
    }

    // Store in Postgres
    const ins = await query(
      `INSERT INTO signnow_documents (lead_id, document_id, template_id, document_name, status, signers, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [lead.id, docId, template_id, finalDocName,
       inviteSent ? 'sent' : 'pending',
       JSON.stringify(signers || (lead.email ? [{ email: lead.email, name: customerName }] : [])),
       req.user.email]
    );

    // Activity log — record the contract creation
    try {
      await query(
        `INSERT INTO activities (lead_id, type, content, author, source, created_at)
         VALUES ($1, 'note', $2, $3, 'manual', NOW())`,
        [lead.id,
         `📄 SignNow contract created from template "${templateName}" — ${inviteSent ? 'sent to ' + (lead.email || 'signer') : 'pending (not sent)'}. Document: ${finalDocName}`,
         req.user.email]
      );
    } catch (actErr) {
      console.warn('[signnow] activity log failed:', actErr.message);
    }

    res.status(201).json({
      document: {
        id: ins.rows[0].id,
        document_id: docId,
        template_id,
        document_name: ins.rows[0].document_name,
        status: ins.rows[0].status,
        signers: ins.rows[0].signers,
        created_at: ins.rows[0].created_at,
      },
      prefilled_fields: prefilledCount,
      prefill_warning: prefillWarning,
    });
  } catch (e) {
    console.error('[signnow] prepare error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /documents/:docId/send — send a PREPARED (pending) document ───────
// The explicit, separate "final review + send" action. prepare/upload create
// a document WITHOUT sending when send_invite is false — this is the only
// way a pending document actually gets emailed to the signer. Never implied
// by creation: automation eliminates duplicate data entry, not the user's
// final control over when a contract actually goes out.
router.post('/documents/:docId/send', requireAdminManager, async (req, res) => {
  try {
    const { docId } = req.params;
    const dbRes = await query('SELECT * FROM signnow_documents WHERE document_id = $1', [docId]);
    const doc = dbRes.rows[0];
    if (!doc) return res.status(404).json({ error: 'not_found' });
    if (doc.status !== 'pending') {
      return res.status(409).json({ error: 'already_sent', message: `This document is already "${doc.status}" — it can only be sent while pending.` });
    }

    const signerList = Array.isArray(doc.signers) && doc.signers.length > 0 ? doc.signers : null;
    if (!signerList) return res.status(400).json({ error: 'no_signers', message: 'This document has no signer on file.' });

    const userInfo = await signnowClient.getUserInfo().catch(() => null);
    const fromEmail = userInfo?.email || '';
    if (!fromEmail) return res.status(502).json({ error: 'Could not determine the SignNow account email to send from.' });

    await signnowClient.sendInvite(docId, signerList, fromEmail);

    const upd = await query(
      `UPDATE signnow_documents SET status = 'sent', updated_at = NOW() WHERE document_id = $1 RETURNING *`,
      [docId]
    );

    try {
      await query(
        `INSERT INTO activities (lead_id, type, content, author, source, created_at)
         VALUES ($1, 'note', $2, $3, 'manual', NOW())`,
        [doc.lead_id, `📤 SignNow contract "${doc.document_name}" sent for signature.`, req.user.email]
      );
    } catch (actErr) {
      console.warn('[signnow] send activity log failed:', actErr.message);
    }

    res.json({
      success: true,
      document: {
        id: upd.rows[0].id,
        document_id: docId,
        document_name: upd.rows[0].document_name,
        status: upd.rows[0].status,
        signers: upd.rows[0].signers,
      },
    });
  } catch (e) {
    if (e.code === 'SIGNNOW_NOT_CONFIGURED') {
      return res.status(501).json({ error: 'signnow_not_configured', message: e.message });
    }
    console.error('[signnow] send error:', e.message);
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
    let snStatus = null;
    let snSigners = null;
    try {
      liveStatus = await signnowClient.getDocumentStatus(docId);
      // SignNow's GET /document/{id} has no top-level 'status' field.
      // Derive status from field_invites array:
      //   - all fulfilled → 'completed'
      //   - any signatures → 'signed'
      //   - invites exist → 'sent'
      //   - otherwise → 'pending'
      const invites = liveStatus.field_invites || [];
      const allFulfilled = invites.length > 0 && invites.every(i => i.status === 'fulfilled');
      const anySigned = (liveStatus.signatures || []).length > 0;
      snStatus = allFulfilled ? 'completed' : anySigned ? 'signed' : invites.length > 0 ? 'sent' : 'pending';
      snSigners = invites.map(i => ({ email: i.email, role: i.role, status: i.status }));
      await query(
        'UPDATE signnow_documents SET status = $1, signers = $2, updated_at = NOW() WHERE document_id = $3',
        [snStatus, JSON.stringify(snSigners), docId]
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
        status: snStatus || dbRes.rows[0].status,
        signers: snSigners || dbRes.rows[0].signers,
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