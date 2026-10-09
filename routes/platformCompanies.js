/* eslint-disable no-undef */
/**
 * /api/v1/platform/companies — Company Management (PRODUCTIZATION —
 * multi-company onboarding workflow). The web UI for the previously
 * CLI-only Company Provisioning System
 * (scripts/install/provisionCompany.js, docs/INSTALL_NEW_COMPANY.md).
 *
 * Auth: lib/rbac.js#requirePlatformAdmin — admin role AND the caller's
 * email present in THIS installation's own company_settings
 * .protected_admin_emails (on EC's production database: Yaron + Michelle;
 * on a fresh company's own installation: nobody — see requirePlatformAdmin's
 * own doc comment).
 *
 *   POST   /                         -> create a draft company (name + owner email)
 *   GET    /                         -> list every company this installation has provisioned
 *   GET    /:id                      -> one company's full record (secrets redacted)
 *   GET    /:id/probe                -> live read-only status probe of the target DB
 *   POST   /:id/infrastructure       -> supply the manually-created Railway DB/URLs; runs full provisioning + sends the owner invite
 *   POST   /:id/resend-invite        -> regenerate + resend the owner's invite link
 *   POST   /:id/suspend              -> disable every user on the target company's own database
 *   POST   /:id/activate             -> re-enable them
 *
 * Deliberately NEVER creates Railway infrastructure itself (no Railway API
 * token is assumed/required) — see docs/INSTALL_NEW_COMPANY.md's own
 * "What's automated vs. what's manual" table and
 * scripts/install/railwayPlan.js's header: creating billable cloud
 * infrastructure always requires its own explicit, in-the-moment human
 * decision. This API automates everything AROUND that one manual step
 * (validation, database schema/seed, invite email, ongoing lifecycle
 * management) so the human step is the ONLY one left.
 */
'use strict';

const express = require('express');
const crypto = require('crypto');
const { requireAuth, requirePlatformAdmin } = require('../lib/rbac');
const { query } = require('../db/client');

const router = express.Router();
router.use(requireAuth, requirePlatformAdmin);

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function slugify(name) {
  const base = String(name || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'company';
  return base;
}

async function uniqueSlug(base) {
  let slug = base;
  for (let i = 0; i < 50; i++) {
    const { rows } = await query('SELECT 1 FROM platform_companies WHERE company_slug = $1', [slug]);
    if (!rows.length) return slug;
    slug = `${base}-${i + 2}`;
  }
  return `${base}-${crypto.randomBytes(3).toString('hex')}`;
}

function redact(row) {
  if (!row) return row;
  const { database_url_encrypted, ...rest } = row; // eslint-disable-line no-unused-vars
  return { ...rest, has_infrastructure: !!database_url_encrypted };
}

// ── POST / — create a draft company (step 1-3 of the onboarding flow) ──────
router.post('/', async (req, res) => {
  try {
    const { company_name, owner_email, owner_name } = req.body || {};
    if (!company_name || !String(company_name).trim()) return res.status(400).json({ error: 'company_name required' });
    if (!owner_email || !EMAIL_RE.test(String(owner_email).trim())) return res.status(400).json({ error: 'a valid owner_email is required' });

    const slug = await uniqueSlug(slugify(company_name));
    const { rows } = await query(
      `INSERT INTO platform_companies (company_name, company_slug, owner_email, owner_name, status, created_by)
       VALUES ($1, $2, lower($3), $4, 'draft', $5)
       RETURNING *`,
      [String(company_name).trim(), slug, String(owner_email).trim(), owner_name || null, req.user.sub]
    );
    res.status(201).json({ company: redact(rows[0]) });
  } catch (e) {
    console.error('[platform-companies] create error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET / — list every company (status, no secrets) ─────────────────────────
router.get('/', async (req, res) => {
  try {
    const { rows } = await query(`SELECT * FROM platform_companies ORDER BY created_at DESC`);
    res.json({ items: rows.map(redact) });
  } catch (e) {
    console.error('[platform-companies] list error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

async function loadCompanyOr404(req, res) {
  const { rows } = await query('SELECT * FROM platform_companies WHERE id = $1', [req.params.id]);
  if (!rows[0]) { res.status(404).json({ error: 'not_found' }); return null; }
  return rows[0];
}

router.get('/:id', async (req, res) => {
  try {
    const row = await loadCompanyOr404(req, res);
    if (!row) return;
    res.json({ company: redact(row) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Read-only live probe — counts only, never actual business records.
router.get('/:id/probe', async (req, res) => {
  try {
    const row = await loadCompanyOr404(req, res);
    if (!row) return;
    if (!row.database_url_encrypted) return res.json({ probe: { reachable: false, error: 'infrastructure not yet configured' } });
    const { decryptPayload } = require('../lib/integrationCredentialStore');
    const { database_url } = decryptPayload(row.database_url_encrypted);
    const { probeCompanyDatabase } = require('../lib/platformProvisioning');
    const probe = await probeCompanyDatabase({ databaseUrl: database_url });
    res.json({ probe });
  } catch (e) {
    console.error('[platform-companies] probe error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /:id/infrastructure — the ONE manual step this API cannot automate:
// the admin has already created a new Railway project + Postgres + services
// by hand (docs/INSTALL_NEW_COMPANY.md Step 2) and pastes the resulting
// connection string + URLs here. Everything after this is automatic:
// migrations, company_settings, a pending (no-password) first admin, and
// the owner's invite email. ────────────────────────────────────────────────
router.post('/:id/infrastructure', async (req, res) => {
  try {
    const row = await loadCompanyOr404(req, res);
    if (!row) return;
    const { database_url, frontend_url, backend_url } = req.body || {};
    if (!database_url || !/^postgres(ql)?:\/\//.test(database_url)) {
      return res.status(400).json({ error: 'a valid postgres(ql):// database_url is required' });
    }
    if (!frontend_url || !backend_url) {
      return res.status(400).json({ error: 'frontend_url and backend_url are required' });
    }

    const contract = require('../scripts/install/companyConfigContract');
    const cfg = {
      company_name: row.company_name,
      company_slug: row.company_slug,
      admin_email: row.owner_email,
      admin_name: row.owner_name || null,
      default_owner_email: row.owner_email,
      default_owner_name: row.owner_name || null,
      // A brand-new company starts with every optional integration OFF —
      // connected one at a time, per module, after first login (same
      // "never have" guarantee docs/INSTALL_NEW_COMPANY.md documents for
      // the CLI path).
      enabled_modules: Object.fromEntries(contract.MODULE_KEYS.map((k) => [k, false])),
      frontend_url,
      backend_url,
      // No admin_password — bootstrap.js creates a PENDING admin instead
      // (see scripts/install/bootstrap.js#ensureFirstAdmin's optional path).
    };
    const validation = contract.validateConfig(cfg);
    if (!validation.ok) {
      return res.status(400).json({ error: 'config_invalid', validation });
    }

    await query(
      `UPDATE platform_companies SET status = 'provisioning', config_json = $1, frontend_url = $2, backend_url = $3,
              contract_version = $4, updated_at = NOW() WHERE id = $5`,
      [JSON.stringify(cfg), frontend_url, backend_url, contract.CONTRACT_VERSION, row.id]
    );

    const { provisionCompanyDatabase } = require('../lib/platformProvisioning');
    let report;
    try {
      report = await provisionCompanyDatabase({ databaseUrl: database_url, cfg });
    } catch (e) {
      await query(`UPDATE platform_companies SET status = 'failed', last_error = $1, updated_at = NOW() WHERE id = $2`, [e.message, row.id]);
      console.error('[platform-companies] provisioning error:', e.message);
      return res.status(502).json({ error: 'provisioning_failed', message: e.message });
    }
    if (!report.ok) {
      await query(`UPDATE platform_companies SET status = 'failed', last_error = $1, updated_at = NOW() WHERE id = $2`, ['post-provision health checks failed', row.id]);
      return res.status(502).json({ error: 'provisioning_health_check_failed', report });
    }

    // Encrypt and store the connection string (reuses the SAME AES-256-CBC
    // helper already used for integration_credentials — never a new scheme).
    const { encryptPayload } = require('../lib/integrationCredentialStore');
    const encrypted = encryptPayload({ database_url });
    await query(
      `UPDATE platform_companies SET database_url_encrypted = $1, status = 'ready_to_invite', provisioned_at = NOW(), updated_at = NOW() WHERE id = $2`,
      [encrypted, row.id]
    );

    // Send the owner's invite — best-effort; the admin can always resend.
    let emailSent = false;
    let inviteUrl = null;
    if (report.first_admin.invite_token) {
      inviteUrl = `${frontend_url.replace(/\/$/, '')}/accept-invite?token=${encodeURIComponent(report.first_admin.invite_token)}`;
      try {
        const { inviteEmail } = require('../lib/emailTemplates');
        const html = inviteEmail({
          recipientName: row.owner_name || null,
          companyName: row.company_name,
          inviteUrl,
          expiresInDays: 7,
          isOwnerInvite: true,
        });
        const emailService = require('../lib/emailService');
        const result = await emailService.send({
          to: row.owner_email,
          subject: `Your ${row.company_name} CRM is ready`,
          htmlBody: html,
          idempotencyKey: `platform-invite-${row.id}-${report.first_admin.invite_token.slice(0, 16)}`,
          fromName: `${row.company_name} CRM`,
        });
        emailSent = !!result?.ok;
      } catch (e) {
        console.warn('[platform-companies] owner invite email failed (non-fatal):', e.message);
      }
    }
    if (emailSent) {
      await query(`UPDATE platform_companies SET status = 'invited', invited_at = NOW(), updated_at = NOW() WHERE id = $1`, [row.id]);
    }

    const { rows: finalRows } = await query('SELECT * FROM platform_companies WHERE id = $1', [row.id]);
    res.json({ company: redact(finalRows[0]), provisioning: report, email_sent: emailSent, invite_url: emailSent ? undefined : inviteUrl });
  } catch (e) {
    console.error('[platform-companies] infrastructure error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /:id/resend-invite ──────────────────────────────────────────────
router.post('/:id/resend-invite', async (req, res) => {
  try {
    const row = await loadCompanyOr404(req, res);
    if (!row) return;
    if (!row.database_url_encrypted) return res.status(409).json({ error: 'infrastructure not yet configured for this company' });

    const { decryptPayload } = require('../lib/integrationCredentialStore');
    const { database_url } = decryptPayload(row.database_url_encrypted);
    const { regenerateInviteOnTarget } = require('../lib/platformProvisioning');
    const result = await regenerateInviteOnTarget({ databaseUrl: database_url, email: row.owner_email });
    if (!result) return res.status(409).json({ error: 'owner_already_activated', message: 'This company\'s owner has already set a password — nothing to resend.' });

    const inviteUrl = `${(row.frontend_url || '').replace(/\/$/, '')}/accept-invite?token=${encodeURIComponent(result.rawToken)}`;
    let emailSent = false;
    try {
      const { inviteEmail } = require('../lib/emailTemplates');
      const html = inviteEmail({ recipientName: row.owner_name || null, companyName: row.company_name, inviteUrl, expiresInDays: 7, isOwnerInvite: true });
      const emailService = require('../lib/emailService');
      const sendResult = await emailService.send({
        to: row.owner_email,
        subject: `Your ${row.company_name} CRM is ready`,
        htmlBody: html,
        idempotencyKey: `platform-invite-resend-${row.id}-${result.rawToken.slice(0, 16)}`,
        fromName: `${row.company_name} CRM`,
      });
      emailSent = !!sendResult?.ok;
    } catch (e) {
      console.warn('[platform-companies] resend-invite email failed (non-fatal):', e.message);
    }
    res.json({ ok: true, email_sent: emailSent, invite_url: emailSent ? undefined : inviteUrl });
  } catch (e) {
    console.error('[platform-companies] resend-invite error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

async function setStatus(req, res, { dbStatus, companyStatus, timestampCol }) {
  const row = await loadCompanyOr404(req, res);
  if (!row) return;
  if (!row.database_url_encrypted) return res.status(409).json({ error: 'infrastructure not yet configured for this company' });
  const { decryptPayload } = require('../lib/integrationCredentialStore');
  const { database_url } = decryptPayload(row.database_url_encrypted);
  const { setCompanyUsersStatus } = require('../lib/platformProvisioning');
  const result = await setCompanyUsersStatus({ databaseUrl: database_url, status: dbStatus });
  await query(`UPDATE platform_companies SET status = $1, ${timestampCol} = NOW(), updated_at = NOW() WHERE id = $2`, [companyStatus, row.id]);
  res.json({ ok: true, updated_users: result.updated_users });
}

// ── POST /:id/suspend — disables every user on the TARGET company's own
// database (never a flag that company's own server has to poll at runtime
// — see lib/platformProvisioning.js#setCompanyUsersStatus's isolation note). ─
router.post('/:id/suspend', async (req, res) => {
  try { await setStatus(req, res, { dbStatus: 'disabled', companyStatus: 'suspended', timestampCol: 'suspended_at' }); }
  catch (e) { console.error('[platform-companies] suspend error:', e.message); res.status(500).json({ error: e.message }); }
});

router.post('/:id/activate', async (req, res) => {
  try { await setStatus(req, res, { dbStatus: 'active', companyStatus: 'activated', timestampCol: 'activated_at' }); }
  catch (e) { console.error('[platform-companies] activate error:', e.message); res.status(500).json({ error: e.message }); }
});

module.exports = router;
