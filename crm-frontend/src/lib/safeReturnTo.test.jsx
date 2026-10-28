import { describe, it, expect } from 'vitest';
import { sanitizeReturnTo } from './safeReturnTo';

describe('sanitizeReturnTo', () => {
  it('accepts a genuine internal lead path unchanged', () => {
    expect(sanitizeReturnTo('/leads/774d31bd-1134-4319-8298-5810dbe196a5')).toBe('/leads/774d31bd-1134-4319-8298-5810dbe196a5');
  });

  it('accepts a path with a query string unchanged', () => {
    expect(sanitizeReturnTo('/leads/abc?tab=activity')).toBe('/leads/abc?tab=activity');
  });

  it('rejects null/undefined/empty', () => {
    expect(sanitizeReturnTo(null)).toBeNull();
    expect(sanitizeReturnTo(undefined)).toBeNull();
    expect(sanitizeReturnTo('')).toBeNull();
  });

  it('rejects an absolute URL (never trusted as a redirect target)', () => {
    expect(sanitizeReturnTo('https://evil.example.com/leads/x')).toBeNull();
  });

  it('rejects a protocol-relative "//host/..." path — the classic open-redirect form', () => {
    expect(sanitizeReturnTo('//evil.example.com/leads/x')).toBeNull();
  });

  it('rejects a path not starting with "/"', () => {
    expect(sanitizeReturnTo('leads/x')).toBeNull();
    expect(sanitizeReturnTo('evil.com/leads/x')).toBeNull();
  });

  it('rejects a scheme disguised as a path segment', () => {
    expect(sanitizeReturnTo('/javascript:alert(1)')).toBeNull();
  });
});
