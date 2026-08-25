#!/usr/bin/env node
/* eslint-disable no-undef */
'use strict';
/**
 * validateMigrationShapes.js — Non-destructive static analysis of migration scripts.
 *
 * Catches TWO classes of defects that the preflight missed:
 *   1. SQL column/placeholder count mismatch (caused Leads failure: 29 cols, 28 placeholders)
 *   2. Undefined variable references (caused Appointments failure: consultulationTypeId typo)
 *
 * This script does NOT connect to the database, does NOT write records, and does NOT
 * call any external APIs. It reads migration script source files and validates them
 * statically.
 *
 * Usage:
 *   node scripts/validateMigrationShapes.js           # validate all scripts
 *   node scripts/validateMigrationShapes.js --quiet    # only print failures
 *
 * Exit code: 0 = all scripts pass, 1 = one or more scripts have defects
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SCRIPTS_DIR = __dirname;
const QUIET = process.argv.includes('--quiet');

function log(msg) { if (!QUIET) console.log(msg); }
function logErr(msg) { console.error(msg); }

// ── 1. SQL Shape Validation ─────────────────────────────────────────────────
/**
 * Extract INSERT INTO statements from a JS source file and verify that the
 * column count matches the value count (placeholders + literals).
 *
 * Uses parenthesis-matching to handle nested function calls like
 * tstzrange($4, $5) and NOW() inside the VALUES clause.
 *
 * Catches: "INSERT has more target columns than expressions" (PostgreSQL error)
 */
function findMatchingParen(source, openIdx) {
  let depth = 1;
  for (let i = openIdx + 1; i < source.length; i++) {
    if (source[i] === '(') depth++;
    else if (source[i] === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1; // unmatched
}

function validateSqlShapes(filePath) {
  const source = fs.readFileSync(filePath, 'utf8');
  const issues = [];

  // Find all INSERT INTO occurrences
  const insertKeyword = 'INSERT INTO';
  let searchFrom = 0;
  while (true) {
    const insertIdx = source.indexOf(insertKeyword, searchFrom);
    if (insertIdx === -1) break;
    searchFrom = insertIdx + 1;

    // Find the table name
    const afterInsert = source.slice(insertIdx);
    const tableMatch = afterInsert.match(/^INSERT\s+INTO\s+(\w+)/i);
    if (!tableMatch) continue;
    const table = tableMatch[1];

    // Find the opening ( for column list
    const colListOpen = source.indexOf('(', insertIdx + insertKeyword.length);
    if (colListOpen === -1) continue;
    const colListClose = findMatchingParen(source, colListOpen);
    if (colListClose === -1) continue;
    const colSection = source.slice(colListOpen + 1, colListClose);

    // Find VALUES keyword after column list
    const valuesIdx = source.indexOf('VALUES', colListClose);
    if (valuesIdx === -1) continue;

    // Find the opening ( for value list
    const valListOpen = source.indexOf('(', valuesIdx);
    if (valListOpen === -1) continue;
    const valListClose = findMatchingParen(source, valListOpen);
    if (valListClose === -1) continue;
    const valSection = source.slice(valListOpen + 1, valListClose);

    // Count columns (split by comma at depth 0)
    const columns = splitAtDepth0(colSection);
    const valueTokens = splitAtDepth0(valSection);

    // Count only $N placeholders (including $N::type casts)
    const placeholders = valueTokens.filter(v => /^\$\d+/.test(v.trim()));

    // Count non-placeholder literals (NOW(), true, 1, null, tstzrange(...), etc.)
    const literals = valueTokens.filter(v => !/^\$\d+/.test(v.trim()));

    const totalValues = placeholders.length + literals.length;

    if (columns.length !== totalValues) {
      issues.push({
        type: 'SQL_SHAPE_MISMATCH',
        table,
        columns: columns.length,
        values: totalValues,
        placeholders: placeholders.length,
        literals: literals.length,
        detail: `${columns.length} columns but ${totalValues} values (${placeholders.length} placeholders + ${literals.length} literals)`,
      });
    }
  }

  return issues;
}

// Split a string on commas that are at parenthesis depth 0
function splitAtDepth0(str) {
  let depth = 0;
  let current = '';
  const tokens = [];
  for (const ch of str) {
    if (ch === '(') { depth++; current += ch; }
    else if (ch === ')') { depth--; current += ch; }
    else if (ch === ',' && depth === 0) { tokens.push(current.trim()); current = ''; }
    else { current += ch; }
  }
  if (current.trim().length > 0) tokens.push(current.trim());
  return tokens.filter(t => t.length > 0);
}

// ── 2. Variable Reference Validation ────────────────────────────────────────
/**
 * Extract const/let declarations and check if variables used in if-conditions
 * are actually declared. Catches typos like consultulationTypeId → consultationTypeId.
 *
 * This is a lightweight static check — not a full JS parser. It catches the
 * common pattern of declaring a variable and then misspelling it in a condition.
 */
function validateVariableRefs(filePath) {
  const source = fs.readFileSync(filePath, 'utf8');
  const issues = [];

  // Extract all const/let/var declarations — including comma-separated:
  //   const name = ... (single)
  //   let a = 0, b = 0, errors = 0 (multiple — need to catch all names)
  const declRegex = /(?:const|let|var)\s+([^;]+);/g;
  const declaredVars = new Set();
  let match;
  while ((match = declRegex.exec(source)) !== null) {
    // Split multiple declarations: "a = 0, b = 0, errors = 0" → ["a", "b", "errors"]
    const decls = match[1].split(',');
    for (const d of decls) {
      const nameMatch = d.trim().match(/^([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=/);
      if (nameMatch) declaredVars.add(nameMatch[1]);
    }
  }

  // Also extract function parameters: function name(a, b) { ... } or (a, b) => ...
  const funcParamRegex = /(?:function\s+\w+|function|\()\s*\(([^)]*)\)/g;
  while ((match = funcParamRegex.exec(source)) !== null) {
    const params = match[1].split(',').map(p => p.trim().split(/\s+as\s+/)[0].trim());
    for (const p of params) {
      const clean = p.match(/^([a-zA-Z_$][a-zA-Z0-9_$]*)/);
      if (clean) declaredVars.add(clean[1]);
    }
  }

  // Also extract destructured require: const { a, b } = require(...)
  const destructureRegex = /(?:const|let|var)\s*\{([^}]+)\}\s*=\s*require/g;
  while ((match = destructureRegex.exec(source)) !== null) {
    const names = match[1].split(',').map(n => n.trim().split(/\s+as\s+/)[0].trim());
    for (const n of names) {
      const clean = n.match(/^([a-zA-Z_$][a-zA-Z0-9_$]*)/);
      if (clean) declaredVars.add(clean[1]);
    }
  }

  // Add common globals and function parameters used across migration scripts
  const globals = new Set([
    'console', 'process', 'require', 'module', 'exports', 'Buffer',
    'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
    'Promise', 'JSON', 'Date', 'Math', 'Number', 'String', 'Boolean',
    'Array', 'Object', 'Error', 'RegExp', 'parseInt', 'parseFloat',
    'isNaN', 'NaN', 'undefined', 'null', 'true', 'false',
    'query', 'pool', 'fetchBase44Entity', 'hasBase44Creds',
    'buildLeadIdCache', 'buildDealIdCache', 'buildExpenseIdCache',
    'buildOwnerCache', 'resolveOwnerId', 'OWNER_ALIASES',
    'BASE44_FUNCTIONS_URL', 'WORKER_SECRET', 'BASE44_API_URL',
    'fs', 'path', 'execSync', 'spawnSync', 'crypto',
    // Common counter variables used in migration scripts
    'created', 'updated', 'skipped', 'errors', 'leadNotFound', 'dealNotFound',
    'ownerNotFound', 'expenseNotFound', 'noDate', 'noName', 'unmapped', 'mapped',
    'unresolvedNamedOwners', 'genuinelyUnassigned', 'unassignedOwnerId',
    'totalLeadsWithNamedOwner', 'totalLeadsGenuinelyUnassigned',
    'unresolvedOwnerCount', 'ownerCheckStatus', 'failedReads',
    'activeOwnersCount', 'b44Reachable', 'b44ProbeError',
    // Function parameters
    'req', 'res', 'next', 'item', 'lead', 'deal', 'task', 'inv', 'est', 'prop', 'activity',
    'railwayLeadId', 'railwayDealId', 'railwayExpenseId', 'ownerId', 'externalRef',
    'ownerCache', 'leadIdCache', 'dealIdCache', 'expenseIdCache',
    'base44Leads', 'base44Deals', 'base44Items', 'base44Activities', 'base44Users',
    'base44Settings', 'base44Company', 'base44Tasks', 'base44Invoices', 'base44Estimates',
    'base44Properties', 'base44Estimates_handoff', 'base44Submissions', 'base44SignNow',
    'base44Attachments', 'base44Expenses', 'base44ExpensePayments', 'base44Commissions',
    'base44LoanPayments', 'base44Contacts', 'base44Access', 'base44Allowlist', 'base44Cursors',
    'consultationTypeId', 'meetingTypeId', 'apptDate', 'apptTime', 'apptType',
    'apptTypeId', 'startAt', 'endAt', 'endAtStr', 'startDate', 'endDate', 'status',
    'idempotencyKey', 'photoUrls', 'lineItems', 'signers', 'signersJson', 'railwayStatus',
    'statusMap', 'metadata', 'createdAt', 'summary', 'emailRecipients',
    'IS_PREFLIGHT', 'ALL_DATASETS', 'EXCLUDED_DATASETS', 'results',
    'hasCreds', 'missingTables', 'totalB44', 'totalRW', 'failReasons',
    'smallDatasetsRun', 'stepNum', 'ds',
  ]);
  for (const g of globals) declaredVars.add(g);

  // Check if (!varName) and if (varName) patterns — these are the most common
  // source of ReferenceError typos in migration scripts
  const condRegex = /if\s*\(\s*!?\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?:\|\||\&\&|\)|\s)/g;
  while ((match = condRegex.exec(source)) !== null) {
    const varName = match[1];
    if (!declaredVars.has(varName) && !globals.has(varName)) {
      // Check if it's a property access (obj.prop) — skip those
      const beforeMatch = source.slice(Math.max(0, match.index - 5), match.index);
      if (beforeMatch.includes('.')) continue;

      issues.push({
        type: 'UNDEFINED_VARIABLE',
        variable: varName,
        line: source.slice(0, match.index).split('\n').length,
        detail: `Variable '${varName}' used in condition but not declared with const/let/var`,
      });
    }
  }

  return issues;
}

// ── 3. Syntax Check ──────────────────────────────────────────────────────────
/**
 * Run `node --check` on each script to catch syntax errors.
 */
function validateSyntax(filePath) {
  try {
    execSync(`node --check "${filePath}"`, { stdio: 'pipe', timeout: 10000 });
    return [];
  } catch (e) {
    return [{
      type: 'SYNTAX_ERROR',
      detail: (e.stderr || e.stdout || e.message || '').toString().slice(0, 200),
    }];
  }
}

// ── Main ────────────────────────────────────────────────────────────────────
function main() {
  const scripts = fs.readdirSync(SCRIPTS_DIR)
    .filter(f => f.startsWith('migrate') && f.endsWith('.js'))
    .sort();

  log(`\n=== MIGRATION SHAPE VALIDATION ===\n`);
  log(`Validating ${scripts.length} migration scripts...\n`);

  let totalIssues = 0;
  const results = [];

  for (const script of scripts) {
    const filePath = path.join(SCRIPTS_DIR, script);
    const syntaxIssues = validateSyntax(filePath);
    const sqlIssues = validateSqlShapes(filePath);
    const varIssues = validateVariableRefs(filePath);
    const allIssues = [...syntaxIssues, ...sqlIssues, ...varIssues];

    totalIssues += allIssues.length;
    results.push({ script, issues: allIssues });

    if (allIssues.length === 0) {
      log(`  ✅ ${script}`);
    } else {
      logErr(`  ❌ ${script} — ${allIssues.length} issue(s):`);
      for (const issue of allIssues) {
        logErr(`     ${issue.type}: ${issue.detail}`);
        if (issue.table) logErr(`        Table: ${issue.table}, Columns: ${issue.columns}, Values: ${issue.values}`);
        if (issue.variable) logErr(`        Variable: ${issue.variable}, Line: ${issue.line || '?'}`);
      }
    }
  }

  log(`\n=== VALIDATION SUMMARY ===\n`);
  log(`Scripts validated: ${scripts.length}`);
  log(`Total issues: ${totalIssues}`);

  if (totalIssues > 0) {
    logErr(`\n❌ VALIDATION FAILED — ${totalIssues} defect(s) found`);
    logErr('Fix these before running the full migration.');
    process.exit(1);
  }

  log(`\n✅ ALL MIGRATION SCRIPTS PASS SHAPE VALIDATION`);
  process.exit(0);
}

main();