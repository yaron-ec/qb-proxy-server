'use strict';
/**
 * Deployed build identity — ONE canonical source, shared by GET /health
 * (public, no auth) and GET /api/v1/system/info (admin-only). Previously
 * duplicated inline inside routes/systemInfo.js; extracted so both call
 * sites can never drift on how the commit SHA is resolved.
 *
 * Railway sets RAILWAY_GIT_COMMIT_SHA automatically on every deploy — no
 * Railway project/service UUID is ever hardcoded here, only a well-known,
 * platform-generic env var name any Railway deployment gets for free.
 * Falls back to `git rev-parse HEAD` for local/non-Railway environments.
 *
 * A commit SHA is not a secret — it is already public in this repository's
 * own history — so exposing it unauthenticated on GET /health (which already
 * reports other non-secret install metadata) adds no new disclosure.
 */

let _buildCommit = null;
function buildCommit() {
  if (_buildCommit) return _buildCommit;
  if (process.env.RAILWAY_GIT_COMMIT_SHA) {
    _buildCommit = process.env.RAILWAY_GIT_COMMIT_SHA;
    return _buildCommit;
  }
  try {
    _buildCommit = require('child_process')
      .execSync('git rev-parse HEAD', { cwd: __dirname + '/..', stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch (e) {
    _buildCommit = null;
  }
  return _buildCommit;
}

let _pkgVersion = null;
function productVersion() {
  if (_pkgVersion) return _pkgVersion;
  _pkgVersion = require('../package.json').version;
  return _pkgVersion;
}

module.exports = { buildCommit, productVersion };
