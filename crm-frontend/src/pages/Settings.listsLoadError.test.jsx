/**
 * Settings.listsLoadError.test.jsx — regression coverage for a found-in-audit
 * defect: Settings.jsx's Statuses/Project Types/Sources/Contact Owners
 * editors fetch their saved lists from `app_lists` (and Contact Owners also
 * fetches `owner_emails`), initializing their state to hardcoded DEFAULT_*
 * values and only overriding on a successful, non-empty response. A FAILED
 * fetch (network error, or any role that can't read the settings endpoint)
 * was previously swallowed by a bare `.catch(() => {})` — leaving the editor
 * showing the hardcoded defaults with no indication they might not be the
 * real saved list. Because every "add"/"remove" action in these tabs saves
 * the CURRENTLY DISPLAYED list back via a full-list replace (`app_lists`)
 * or an object-spread merge (`owner_emails`), an admin editing from that
 * silently-wrong state could overwrite their real saved settings without
 * any warning.
 *
 * FIX: track the fetch failure explicitly (listsLoadError / emailsLoadError)
 * and surface a visible SettingsLoadWarning banner on every affected editor
 * instead of silently proceeding as if the defaults were authoritative.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const src = fs.readFileSync(path.join(__dirname, 'Settings.jsx'), 'utf8');

describe('Settings.jsx surfaces load failures instead of silently trusting defaults', () => {
  it('REGRESSION: the app_lists fetch no longer uses a bare empty catch', () => {
    expect(src).not.toMatch(/railwaySettings\.get\("app_lists"\)\.then\([\s\S]*?\}\)\.catch\(\(\) => \{\}\);/);
    expect(src).toMatch(/\.catch\(\(e\) => setListsLoadError\(e\?\.message \|\| 'Failed to load saved settings\.'\)\);/);
  });

  it('REGRESSION: the owner_emails fetch no longer uses a bare empty catch', () => {
    expect(src).toMatch(/\.catch\(\(e\) => setEmailsLoadError\(e\?\.message \|\| 'Failed to load saved owner emails\.'\)\);/);
  });

  it('every list editor renders the SettingsLoadWarning banner', () => {
    expect(src).toMatch(/function StatusesTab\([\s\S]*?<SettingsLoadWarning loadError=\{loadError\} \/>/);
    expect(src).toMatch(/function ProjectTypesTab\([\s\S]*?<SettingsLoadWarning loadError=\{loadError\} \/>/);
    expect(src).toMatch(/function SourcesTab\([\s\S]*?<SettingsLoadWarning loadError=\{loadError\} \/>/);
    expect(src).toMatch(/function ContactOwnersTab\([\s\S]*?<SettingsLoadWarning loadError=\{loadError\} \/>[\s\S]*?<SettingsLoadWarning loadError=\{emailsLoadError\} \/>/);
  });

  it('the load errors are wired from the top-level fetch down to each editor as a prop', () => {
    expect(src).toMatch(/<StatusesTab[\s\S]*?loadError=\{listsLoadError\}/);
    expect(src).toMatch(/<ProjectTypesTab[\s\S]*?loadError=\{listsLoadError\}/);
    expect(src).toMatch(/<SourcesTab[\s\S]*?loadError=\{listsLoadError\}/);
    expect(src).toMatch(/<ContactOwnersTab[\s\S]*?loadError=\{listsLoadError\}/);
  });
});
