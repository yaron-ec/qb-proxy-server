/**
 * LeadDetailModern.leadSources.test.jsx — regression coverage for the same
 * bug class as LeadDetailModern.jobType.test.jsx's Job Type fix, found in
 * this repo's system-wide stability audit: Lead Detail's "Source" field
 * (EditableField type="select") could render with zero options.
 *
 * ROOT CAUSE: routes/leads.js's composite GET /detail endpoint always
 * returns `leadSources: appLists.sources || []` — a real, empty array
 * whenever the app_settings 'app_lists' row has no sources saved. The old
 * code did `if (data.leadSources) lSources = data.leadSources;` — `[]` is
 * truthy in JS — AND `leadSources` state had no canonical default at all
 * (it was initialized to `[]`), so an empty server response (or no
 * response, on a role that can't reach the settings-backed composite field)
 * left the Source dropdown with nothing to pick from.
 *
 * FIX: give `leadSources` state the same canonical, non-empty default
 * Settings.jsx's Lead Sources tab already pre-populates
 * (Settings.jsx's own DEFAULT_SOURCES), and only override it when the
 * server actually sent a non-empty array (Array.isArray + length check),
 * matching the pattern already used for projectTypes.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const SRC_PATH = path.join(__dirname, 'LeadDetailModern.jsx');
const src = fs.readFileSync(SRC_PATH, 'utf8');

describe('root cause — loadData never lets an empty/missing leadSources response blank the canonical default', () => {
  it('REGRESSION: an empty leadSources array from the composite detail endpoint is never treated as an override (Array.isArray + non-empty length check, not a bare truthiness check)', () => {
    expect(src).toMatch(/if \(Array\.isArray\(data\.leadSources\) && data\.leadSources\.length > 0\) lSources = data\.leadSources;/);
    // The old bare-truthiness check (`if (data.leadSources) lSources = ...`)
    // — which treats `[]` as a valid override — must not be present any more.
    expect(src).not.toMatch(/if \(data\.leadSources\) lSources = data\.leadSources;/);
  });

  it('leadSources state is initialized to a non-empty canonical default, not an empty array', () => {
    expect(src).toMatch(/const \[leadSources, setLeadSources\] = useState\(DEFAULT_LEAD_SOURCES\);/);
    expect(src).toMatch(/const DEFAULT_LEAD_SOURCES = \[/);
  });

  it('DEFAULT_LEAD_SOURCES matches the admin-configured default list in Settings.jsx (not invented, not a divergent list)', () => {
    const settingsSrc = fs.readFileSync(
      path.join(__dirname, 'Settings.jsx'),
      'utf8'
    );
    const settingsDefaults = settingsSrc.match(/const DEFAULT_SOURCES = \[([\s\S]*?)\];/)[1];
    const localDefaults = src.match(/const DEFAULT_LEAD_SOURCES = \[([\s\S]*?)\];/)[1];
    const parseList = (block) => block.match(/"[^"]+"/g);
    expect(parseList(localDefaults)).toEqual(parseList(settingsDefaults));
  });
});
