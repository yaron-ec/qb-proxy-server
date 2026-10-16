import { describe, it, expect } from 'vitest';
import { getAppleMapsDirectionsUrl, getAppleMapsDirectionsUrlFromCoords } from './appleMapsDirections';

describe('getAppleMapsDirectionsUrl', () => {
  it('builds the official Apple Maps universal directions link with an encoded address', () => {
    const url = getAppleMapsDirectionsUrl('123 Main St, Los Angeles, CA');
    expect(url).toBe('https://maps.apple.com/?daddr=123%20Main%20St%2C%20Los%20Angeles%2C%20CA&dirflg=d');
  });

  it('properly encodes special characters (&, #, unicode) in the destination', () => {
    const url = getAppleMapsDirectionsUrl('5 & 10 Café, Unit #2');
    expect(url).toContain('daddr=5%20%26%2010%20Caf%C3%A9%2C%20Unit%20%232');
    expect(url).toMatch(/^https:\/\/maps\.apple\.com\/\?daddr=/);
  });

  it('never uses the maps:// custom scheme (desktop browsers cannot resolve it)', () => {
    const url = getAppleMapsDirectionsUrl('1 Main St');
    expect(url.startsWith('https://')).toBe(true);
  });

  it('requests driving directions (dirflg=d)', () => {
    const url = getAppleMapsDirectionsUrl('1 Main St');
    expect(url).toContain('dirflg=d');
  });

  it('returns null for a missing address', () => {
    expect(getAppleMapsDirectionsUrl(undefined)).toBeNull();
    expect(getAppleMapsDirectionsUrl(null)).toBeNull();
  });

  it('returns null for a blank/whitespace-only address (invalid address, handled safely)', () => {
    expect(getAppleMapsDirectionsUrl('')).toBeNull();
    expect(getAppleMapsDirectionsUrl('   ')).toBeNull();
  });

  it('returns null for a non-string destination', () => {
    expect(getAppleMapsDirectionsUrl(42)).toBeNull();
    expect(getAppleMapsDirectionsUrl({})).toBeNull();
  });
});

describe('getAppleMapsDirectionsUrlFromCoords', () => {
  it('builds a "lat,lng" destination', () => {
    const url = getAppleMapsDirectionsUrlFromCoords(34.0522, -118.2437);
    expect(url).toBe('https://maps.apple.com/?daddr=34.0522%2C-118.2437&dirflg=d');
  });

  it('returns null when lat/lng are missing or not numbers (handles invalid coordinates safely)', () => {
    expect(getAppleMapsDirectionsUrlFromCoords(null, null)).toBeNull();
    expect(getAppleMapsDirectionsUrlFromCoords(undefined, undefined)).toBeNull();
    expect(getAppleMapsDirectionsUrlFromCoords('34.05', '-118.24')).toBeNull();
    expect(getAppleMapsDirectionsUrlFromCoords(NaN, NaN)).toBeNull();
  });
});
