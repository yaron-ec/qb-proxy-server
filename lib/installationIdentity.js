/* eslint-disable no-undef */
/**
 * installationIdentity — safety gate for destructive maintenance scripts.
 *
 * PROBLEM this solves: under the productized single-tenant-per-deployment
 * model (docs/PRODUCT_ARCHITECTURE.md), every company has its OWN database.
 * A script written/tested against one installation must not be able to run
 * against another by accident — a copy-pasted terminal command, a stale
 * DATABASE_URL left in a shell, a shared runbook followed against the wrong
 * environment. Generalizes the pattern already used in
 * scripts/auditAppointmentFollowUp.js's --confirm-host flag to any script
 * that mutates data.
 *
 * Usage in a script:
 *   const { requireInstallationConfirmation } = require('../lib/installationIdentity');
 *   await requireInstallationConfirmation(process.argv.slice(2));
 *   // ... proceed only if this resolved without throwing/exiting.
 *
 * The script's caller must pass --confirm-installation=<id-or-name> matching
 * either this database's company_settings.installation_id (uuid) or its
 * company_name (human-readable — printed by `identify()` so an operator can
 * read it off before deciding). Mismatch or missing flag exits(2) with a
 * clear message and NEVER proceeds. This is a per-script opt-in gate, not
 * enforced by the application itself — it protects tooling, not normal CRUD.
 */
'use strict';

const { query } = require('../db/client');

/**
 * @returns {Promise<{ installationId: string|null, companyName: string|null, configured: boolean }>}
 */
async function identify() {
  const { rows } = await query('SELECT installation_id, company_name FROM company_settings ORDER BY created_at ASC LIMIT 1');
  const row = rows[0];
  return {
    installationId: row?.installation_id || null,
    companyName: row?.company_name || null,
    configured: !!row,
  };
}

function flagValue(args, name) {
  const f = args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!f) return null;
  return f.includes('=') ? f.split('=').slice(1).join('=') : true;
}

/**
 * Throws (does not process.exit — the caller decides how to fail) unless
 * --confirm-installation=<installation_id|company_name> matches this
 * database. Prints the resolved identity either way so a script that is
 * about to fail still tells the operator what it's connected to.
 *
 * @param {string[]} argv - typically process.argv.slice(2)
 * @param {{ log?: (...a: any[]) => void }} [opts]
 */
async function requireInstallationConfirmation(argv, opts = {}) {
  const log = opts.log || console.error;
  const id = await identify();
  const label = id.companyName ? `"${id.companyName}" (${id.installationId || 'no installation_id — pre-productization row'})` : '(no company_settings row — unbootstrapped database)';
  log(`[installationIdentity] connected to: ${label}`);

  const confirm = flagValue(argv, 'confirm-installation');
  if (!confirm || confirm === true) {
    throw new Error(`Refusing to proceed: pass --confirm-installation=<installation_id or company_name> to confirm you intend to run this against ${label}.`);
  }
  // An unbootstrapped database (no company_settings row yet) has no identity
  // to match against — there is nothing to protect because no company's data
  // exists there yet. Requiring the flag at all (rather than skipping the
  // gate) still forces an explicit, deliberate opt-in; any non-empty value
  // satisfies it once that identity doesn't exist to compare to.
  const matches = id.configured
    ? (confirm === id.installationId || (id.companyName && confirm.toLowerCase() === id.companyName.toLowerCase()))
    : true;
  if (!matches) {
    throw new Error(`Refusing to proceed: --confirm-installation=${JSON.stringify(confirm)} does not match the connected database (${label}). Nothing changed.`);
  }
  log('[installationIdentity] confirmation matched — proceeding.');
  return id;
}

module.exports = { identify, requireInstallationConfirmation };
