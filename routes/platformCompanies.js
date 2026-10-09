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
 *   POST   /:id/infrastructure       -> MANUAL fallback: supply the manually-created Railway DB/URLs; runs full provisioning + sends the owner invite
 *   POST   /:id/estimate             -> AUTOMATED path step 1: compute (never create) the Railway services + cost estimate for this company
 *   POST   /:id/provision            -> AUTOMATED path step 2: creates real Railway infrastructure — requires confirm_cost_usd to echo the stored estimate
 *   POST   /:id/resend-invite        -> regenerate + resend the owner's invite link
 *   POST   /:id/suspend              -> disable every user on the target company's own database
 *   POST   /:id/activate             -> re-enable them
 *
 * TWO provisioning paths now coexist:
 *   - MANUAL (/infrastructure): the original PR #24 flow. Always available,
 *     needs no Railway credential of any kind. The admin creates the
 *     Railway project/Postgres/services by hand (docs/INSTALL_NEW_COMPANY.md
 *     Step 2) and pastes the resulting connection details here.
 *   - AUTOMATED (/estimate + /provision): creates the Railway project,
 *     Postgres, services, variables, domains, deploys, and verifies health,
 *     fully automatically — see lib/platformInfraProvisioning.js. Gated on
 *     RAILWAY_API_TOKEN being configured on THIS installation (a one-time,
 *     human, Railway-dashboard action — see docs/INSTALL_NEW_COMPANY.md's
 *     "Automated infrastructure" section); falls back to a clear 501 if not
 *     configured, never a silent no-op. Real Railway resources are never
 *     created by /estimate (pure computation) — only /provision creates
 *     anything, and only once the admin has echoed back the exact estimate
 *     it computed, satisfying "never create billable infrastructure without
 *     explicit cost approval".
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

// The raw invite token must NEVER appear in an HTTP response, a log line,
// or any company's own database (see this feature's own "never expose
// tokens in the frontend, logs, or company databases" requirement) — it is
// only ever used, in-process, to build the invite email/fallback link via
// sendOwnerInvite() above. Both /infrastructure and /provision return the
// underlying provisioning report for the admin UI's own status display;
// this strips the one sensitive field out of it first.
function redactProvisioningReport(report) {
  if (!report || !report.first_admin) return report;
  const { invite_token, ...restAdmin } = report.first_admin; // eslint-disable-line no-unused-vars
  return { ...report, first_admin: restAdmin };
}

// Shared by /infrastructure, /provision and /resend-invite — one
// implementation of "build the invite email + send it + report the
// fallback link on failure", never three slightly-different copies.
async function sendOwnerInvite(row, { frontendUrl, inviteToken, idempotencyKey }) {
  if (!inviteToken) return { emailSent: false, inviteUrl: null };
  const inviteUrl = `${(frontendUrl || '').replace(/\/$/, '')}/accept-invite?token=${encodeURIComponent(inviteToken)}`;
  let emailSent = false;
  try {
    const { inviteEmail } = require('../lib/emailTemplates');
    const html = inviteEmail({ recipientName: row.owner_name || null, companyName: row.company_name, inviteUrl, expiresInDays: 7, isOwnerInvite: true });
    const emailService = require('../lib/emailService');
    const result = await emailService.send({
      to: row.owner_email,
      subject: `Your ${row.company_name} CRM is ready`,
      htmlBody: html,
      idempotencyKey,
      fromName: `${row.company_name} CRM`,
    });
    emailSent = !!result?.ok;
  } catch (e) {
    console.warn('[platform-companies] owner invite email failed (non-fatal):', e.message);
  }
  return { emailSent, inviteUrl: emailSent ? null : inviteUrl };
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

// ── POST /:id/estimate — AUTOMATED path step 1: pure computation, creates
// NOTHING. Figures out which Railway services this company needs (reuses
// scripts/install/railwayPlan.js, never a second copy) and an approximate
// monthly cost range, and stores both on the row so /provision can later
// require the admin to echo the exact number back — the explicit
// cost-approval gate. Safe to call repeatedly (e.g. after enabled_modules
// changes) — it always just recomputes and overwrites the stored estimate,
// never touches Railway or the target database. ──────────────────────────
router.post('/:id/estimate', async (req, res) => {
  try {
    const row = await loadCompanyOr404(req, res);
    if (!row) return;
    const contract = require('../scripts/install/companyConfigContract');
    const cfg = {
      company_name: row.company_name,
      company_slug: row.company_slug,
      admin_email: row.owner_email,
      admin_name: row.owner_name || null,
      default_owner_email: row.owner_email,
      default_owner_name: row.owner_name || null,
      // Same "every optional integration OFF at first boot" default the
      // manual path uses — an automated company starts equally clean.
      enabled_modules: Object.fromEntries(contract.MODULE_KEYS.map((k) => [k, false])),
    };
    const { estimateInfrastructure } = require('../lib/platformInfraProvisioning');
    const estimate = estimateInfrastructure(cfg);
    await query(
      `UPDATE platform_companies SET
         cost_estimate_monthly_usd = $1,
         cost_estimate_breakdown = $2::jsonb,
         config_json = $3::jsonb,
         contract_version = $4,
         status = CASE WHEN status = 'draft' THEN 'awaiting_infrastructure' ELSE status END,
         updated_at = NOW()
       WHERE id = $5`,
      [estimate.estimated_monthly_usd_high, JSON.stringify(estimate), JSON.stringify(cfg), contract.CONTRACT_VERSION, row.id]
    );
    const { isConfigured } = require('../lib/platformRailway');
    res.json({ estimate, railway_automation_available: isConfigured() });
  } catch (e) {
    console.error('[platform-companies] estimate error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

const JSONB_COLUMNS = new Set(['provisioning_state', 'railway_service_ids', 'cost_estimate_breakdown']);

// ── POST /:id/provision — AUTOMATED path step 2: creates REAL, billable
// Railway infrastructure. Requires /estimate to have already run on this
// company AND confirm_cost_usd to exactly echo the estimate it stored —
// this is the explicit, auditable "I approve this cost" gate; there is no
// way to reach this far without it. Resumable: calling this again after a
// failure picks up from whichever step provisioning_state last recorded,
// never re-creating a Railway resource that already exists. ──────────────
router.post('/:id/provision', async (req, res) => {
  try {
    const row = await loadCompanyOr404(req, res);
    if (!row) return;

    const railway = require('../lib/platformRailway');
    if (!railway.isConfigured()) {
      return res.status(501).json({
        error: 'railway_automation_not_configured',
        message: 'RAILWAY_API_TOKEN is not set on this installation — automated provisioning is unavailable. Use "Mark Infrastructure Ready" (manual) instead, or configure RAILWAY_API_TOKEN to enable automation (see docs/INSTALL_NEW_COMPANY.md).',
      });
    }
    if (row.cost_estimate_monthly_usd == null) {
      return res.status(409).json({ error: 'no_estimate', message: 'Call POST /:id/estimate first.' });
    }
    const { confirm_cost_usd } = req.body || {};
    const estimateUsd = Number(row.cost_estimate_monthly_usd);
    if (typeof confirm_cost_usd !== 'number' || Math.abs(confirm_cost_usd - estimateUsd) > 0.01) {
      return res.status(400).json({
        error: 'cost_not_confirmed',
        message: `confirm_cost_usd must exactly echo the stored estimate ($${estimateUsd}/mo) to proceed.`,
        estimate_usd: estimateUsd,
      });
    }
    if (!row.config_json || !Object.keys(row.config_json).length) {
      return res.status(409).json({ error: 'no_config', message: 'Call POST /:id/estimate first (it also stores the config this step provisions from).' });
    }

    await query(
      `UPDATE platform_companies SET
         status = 'provisioning',
         cost_confirmed_at = COALESCE(cost_confirmed_at, NOW()),
         cost_confirmed_by = COALESCE(cost_confirmed_by, $1),
         updated_at = NOW()
       WHERE id = $2`,
      [req.user.sub, row.id]
    );

    const onProgress = async (step, patch) => {
      const sets = [];
      const vals = [];
      let idx = 1;
      for (const [k, v] of Object.entries(patch)) {
        if (JSONB_COLUMNS.has(k)) { sets.push(`${k} = $${idx++}::jsonb`); vals.push(JSON.stringify(v)); }
        else { sets.push(`${k} = $${idx++}`); vals.push(v); }
      }
      if (!sets.length) return;
      sets.push('updated_at = NOW()');
      vals.push(row.id);
      await query(`UPDATE platform_companies SET ${sets.join(', ')} WHERE id = $${idx}`, vals);
    };

    const { provisionInfrastructure } = require('../lib/platformInfraProvisioning');
    let result;
    try {
      result = await provisionInfrastructure(row, row.config_json, onProgress);
    } catch (e) {
      await query(`UPDATE platform_companies SET status = 'provisioning_failed', last_error = $1, updated_at = NOW() WHERE id = $2`, [e.message, row.id]);
      console.error('[platform-companies] automated provisioning error:', e.message);
      return res.status(502).json({ error: 'provisioning_failed', message: e.message, retryable: true });
    }

    await query(`UPDATE platform_companies SET status = 'ready_to_invite', provisioned_at = NOW(), updated_at = NOW() WHERE id = $1`, [row.id]);

    // dbReport (and its invite_token) is only populated when the 'database'
    // step actually ran in THIS call — on a call that resumed past an
    // already-completed database step, get a fresh invite token the exact
    // same way "Resend Invite" already does, rather than a second code path.
    let inviteToken = result.dbReport?.first_admin?.invite_token || null;
    if (!inviteToken) {
      const { regenerateInviteOnTarget } = require('../lib/platformProvisioning');
      const r = await regenerateInviteOnTarget({ databaseUrl: result.databaseUrl, email: row.owner_email });
      inviteToken = r?.rawToken || null;
    }

    const { emailSent, inviteUrl } = await sendOwnerInvite(row, {
      frontendUrl: result.frontendUrl,
      inviteToken,
      idempotencyKey: inviteToken ? `platform-invite-auto-${row.id}-${inviteToken.slice(0, 16)}` : undefined,
    });
    if (emailSent) {
      await query(`UPDATE platform_companies SET status = 'invited', invited_at = NOW(), updated_at = NOW() WHERE id = $1`, [row.id]);
    }

    const { rows: finalRows } = await query('SELECT * FROM platform_companies WHERE id = $1', [row.id]);
    res.json({ company: redact(finalRows[0]), provisioning: redactProvisioningReport(result.dbReport), email_sent: emailSent, invite_url: emailSent ? undefined : inviteUrl });
  } catch (e) {
    console.error('[platform-companies] provision error:', e.message);
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
    const { emailSent, inviteUrl } = await sendOwnerInvite(row, {
      frontendUrl: frontend_url,
      inviteToken: report.first_admin.invite_token,
      idempotencyKey: report.first_admin.invite_token ? `platform-invite-${row.id}-${report.first_admin.invite_token.slice(0, 16)}` : undefined,
    });
    if (emailSent) {
      await query(`UPDATE platform_companies SET status = 'invited', invited_at = NOW(), updated_at = NOW() WHERE id = $1`, [row.id]);
    }

    const { rows: finalRows } = await query('SELECT * FROM platform_companies WHERE id = $1', [row.id]);
    res.json({ company: redact(finalRows[0]), provisioning: redactProvisioningReport(report), email_sent: emailSent, invite_url: emailSent ? undefined : inviteUrl });
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

    const { emailSent, inviteUrl } = await sendOwnerInvite(row, {
      frontendUrl: row.frontend_url,
      inviteToken: result.rawToken,
      idempotencyKey: `platform-invite-resend-${row.id}-${result.rawToken.slice(0, 16)}`,
    });
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
