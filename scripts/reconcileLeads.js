#!/usr/bin/env node
/* eslint-disable no-undef */
/**
 * reconcileLeads.js — READ-ONLY data reconciliation tool.
 *
 * Compares Base44 Lead entities with Railway Postgres leads table.
 * Reports: exact counts, missing external_refs, Base44-only, Railway-only,
 * duplicates, status distribution comparison.
 *
 * Usage:
 *   node reconcileLeads.js                          # dry-run (default)
 *   node reconcileLeads.js --apply                   # write migration links
 *   node reconcileLeads.js --base44-only            # show Base44-only leads
 *   node reconcileLeads.js --railway-only           # show Railway-only leads
 *   node reconcileLeads.js --duplicates             # show duplicates
 *
 * Requires: DATABASE_URL env var for Railway Postgres access.
 * If DATABASE_URL is not set, reports Base44 side only and exits.
 */
'use strict';

const DRY_RUN = !process.argv.includes('--apply');
const SHOW_BASE44_ONLY = process.argv.includes('--base44-only');
const SHOW_RAILWAY_ONLY = process.argv.includes('--railway-only');
const SHOW_DUPLICATES = process.argv.includes('--duplicates');

async function main() {
  console.log('=== LEAD RECONCILIATION TOOL ===');
  console.log('Mode: ' + (DRY_RUN ? 'DRY-RUN (read-only)' : 'APPLY (write migration links)'));
  console.log('');

  // ── 1. Load Base44 leads ──────────────────────────────────────────────────
  let base44Leads = [];
  try {
    const { base44 } = require('@base44/sdk');
    base44Leads = await base44.entities.Lead.list('-created_date', 5000, 0);
    console.log('Base44 leads: ' + base44Leads.length);
  } catch (e) {
    console.error('Failed to load Base44 leads:', e.message);
    process.exit(1);
  }

  // ── 2. Load Railway leads (if DATABASE_URL available) ─────────────────────
  let railwayLeads = [];
  const hasDbUrl = !!process.env.DATABASE_URL;
  if (hasDbUrl) {
    try {
      const { Pool } = require('pg');
      const pool = new Pool({ connectionString: process.env.DATABASE_URL });
      const { rows } = await pool.query('SELECT id, external_ref, first_name, last_name, email, phone, status FROM leads ORDER BY created_at DESC');
      railwayLeads = rows;
      await pool.end();
      console.log('Railway leads: ' + railwayLeads.length);
    } catch (e) {
      console.error('Failed to load Railway leads:', e.message);
      console.log('Railway leads: 0 (DB connection failed)');
    }
  } else {
    console.log('Railway leads: SKIPPED (DATABASE_URL not set)');
    console.log('');
    console.log('=== BASE44-ONLY REPORT ===');
    console.log('Total Base44 leads: ' + base44Leads.length);

    // Status distribution
    const statusDist = {};
    for (const l of base44Leads) {
      statusDist[l.status] = (statusDist[l.status] || 0) + 1;
    }
    console.log('Status distribution:');
    for (const [s, c] of Object.entries(statusDist).sort((a, b) => b[1] - a[1])) {
      console.log('  ' + s + ': ' + c);
    }

    // Leads with railway_lead_id
    const withRailwayId = base44Leads.filter(function(l) { return l.railway_lead_id; });
    console.log('\nLeads with railway_lead_id: ' + withRailwayId.length);
    console.log('Leads without railway_lead_id: ' + (base44Leads.length - withRailwayId.length));

    // Duplicate check (same email)
    const emailMap = {};
    for (const l of base44Leads) {
      if (l.email) {
        var key = l.email.toLowerCase().trim();
        if (!emailMap[key]) emailMap[key] = [];
        emailMap[key].push(l);
      }
    }
    var dupes = Object.entries(emailMap).filter(function(e) { return e[1].length > 1; });
    console.log('\nDuplicate emails in Base44: ' + dupes.length);
    if (SHOW_DUPLICATES) {
      for (var i = 0; i < Math.min(dupes.length, 20); i++) {
        var email = dupes[i][0];
        var leads = dupes[i][1];
        console.log('  ' + email + ': ' + leads.map(function(l) { return l.first_name + ' ' + l.last_name + ' (' + l.status + ')'; }).join(', '));
      }
    }

    process.exit(0);
  }

  // ── 3. Reconciliation ────────────────────────────────────────────────────
  console.log('\n=== RECONCILIATION ===');
  console.log('Base44 total: ' + base44Leads.length);
  console.log('Railway total: ' + railwayLeads.length);
  console.log('Difference: ' + (base44Leads.length - railwayLeads.length));

  // Match by external_ref (Base44 ID → Railway external_ref)
  var base44ById = {};
  for (var i = 0; i < base44Leads.length; i++) {
    base44ById[base44Leads[i].id] = base44Leads[i];
  }
  var railwayByExternalRef = {};
  for (var j = 0; j < railwayLeads.length; j++) {
    if (railwayLeads[j].external_ref) {
      railwayByExternalRef[railwayLeads[j].external_ref] = railwayLeads[j];
    }
  }

  var matched = [];
  var base44Only = [];
  var railwayOnly = [];

  for (var i2 = 0; i2 < base44Leads.length; i2++) {
    var b44Lead = base44Leads[i2];
    var railwayLead = railwayByExternalRef[b44Lead.id];
    if (railwayLead) {
      matched.push({ base44: b44Lead, railway: railwayLead });
    } else {
      base44Only.push(b44Lead);
    }
  }

  for (var j2 = 0; j2 < railwayLeads.length; j2++) {
    if (!base44ById[railwayLeads[j2].external_ref]) {
      railwayOnly.push(railwayLeads[j2]);
    }
  }

  console.log('\nMatched (by external_ref): ' + matched.length);
  console.log('Base44-only (not in Railway): ' + base44Only.length);
  console.log('Railway-only (no Base44 counterpart): ' + railwayOnly.length);

  // Status distribution comparison
  console.log('\n=== STATUS DISTRIBUTION ===');
  var b44Status = {};
  for (var i3 = 0; i3 < base44Leads.length; i3++) {
    var s = base44Leads[i3].status;
    b44Status[s] = (b44Status[s] || 0) + 1;
  }
  var railStatus = {};
  for (var j3 = 0; j3 < railwayLeads.length; j3++) {
    var s2 = railwayLeads[j3].status;
    railStatus[s2] = (railStatus[s2] || 0) + 1;
  }

  var allStatuses = Object.keys(Object.assign({}, b44Status, railStatus));
  console.log('Status'.padEnd(40) + 'Base44'.padStart(10) + 'Railway'.padStart(10) + 'Diff'.padStart(10));
  for (var k = 0; k < allStatuses.length; k++) {
    var st = allStatuses[k];
    var b = b44Status[st] || 0;
    var r = railStatus[st] || 0;
    console.log(st.padEnd(40) + String(b).padStart(10) + String(r).padStart(10) + String(b - r).padStart(10));
  }

  // Show Base44-only leads
  if (SHOW_BASE44_ONLY || base44Only.length > 0) {
    console.log('\n=== BASE44-ONLY LEADS (not migrated to Railway) ===');
    var b44OnlyStatus = {};
    for (var i4 = 0; i4 < base44Only.length; i4++) {
      var st2 = base44Only[i4].status;
      b44OnlyStatus[st2] = (b44OnlyStatus[st2] || 0) + 1;
    }
    console.log('Status distribution of Base44-only leads:');
    for (var key2 in b44OnlyStatus) {
      console.log('  ' + key2 + ': ' + b44OnlyStatus[key2]);
    }
    if (SHOW_BASE44_ONLY) {
      console.log('\nFirst 20 Base44-only leads:');
      for (var i5 = 0; i5 < Math.min(base44Only.length, 20); i5++) {
        var l2 = base44Only[i5];
        console.log('  ' + l2.id + ' | ' + l2.first_name + ' ' + l2.last_name + ' | ' + l2.status + ' | ' + (l2.email || 'no email') + ' | ' + (l2.phone || 'no phone'));
      }
    }
  }

  // Show Railway-only leads
  if (SHOW_RAILWAY_ONLY && railwayOnly.length > 0) {
    console.log('\n=== RAILWAY-ONLY LEADS (no Base44 counterpart) ===');
    for (var i6 = 0; i6 < Math.min(railwayOnly.length, 20); i6++) {
      var l3 = railwayOnly[i6];
      console.log('  ' + l3.id + ' | ext_ref=' + (l3.external_ref || 'NULL') + ' | ' + l3.first_name + ' ' + l3.last_name + ' | ' + l3.status);
    }
  }

  // Apply mode: write railway_lead_id back to Base44
  if (!DRY_RUN && matched.length > 0) {
    console.log('\n=== APPLYING MIGRATION LINKS ===');
    var { base44 } = require('@base44/sdk');
    var updated = 0;
    for (var i7 = 0; i7 < matched.length; i7++) {
      var b44Lead2 = matched[i7].base44;
      var railLead = matched[i7].railway;
      if (!b44Lead2.railway_lead_id) {
        try {
          await base44.entities.Lead.update(b44Lead2.id, { railway_lead_id: railLead.id });
          updated++;
        } catch (e) {
          console.error('  Failed to update ' + b44Lead2.id + ':', e.message);
        }
      }
    }
    console.log('Updated ' + updated + ' Base44 leads with railway_lead_id');
  } else if (DRY_RUN && matched.length > 0) {
    console.log('\n(Dry-run: ' + matched.length + ' leads would be linked. Run with --apply to write.)');
  }

  console.log('\n=== RECONCILIATION COMPLETE ===');
}

main().catch(function(e) {
  console.error('Fatal error:', e);
  process.exit(1);
});