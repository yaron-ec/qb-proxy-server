import { describe, it, expect } from 'vitest';
import { hexToHslTriplet } from './brandColor';

describe('hexToHslTriplet', () => {
  it('converts the product default amber (#F59E0B) to the exact CSS token already in index.css', () => {
    expect(hexToHslTriplet('#F59E0B')).toBe('38 92% 50%');
  });

  it('accepts a hex value without a leading #', () => {
    expect(hexToHslTriplet('F59E0B')).toBe('38 92% 50%');
  });

  it('expands a 3-digit shorthand hex', () => {
    expect(hexToHslTriplet('#000')).toBe('0 0% 0%');
    expect(hexToHslTriplet('#fff')).toBe('0 0% 100%');
  });

  it('produces a genuinely different value for a different color (not a hidden amber default)', () => {
    const blue = hexToHslTriplet('#2563EB');
    expect(blue).not.toBe('38 92% 50%');
  });

  it('returns null for malformed input, never throws', () => {
    expect(hexToHslTriplet('not-a-color')).toBeNull();
    expect(hexToHslTriplet('#12345')).toBeNull();
    expect(hexToHslTriplet(null)).toBeNull();
    expect(hexToHslTriplet(undefined)).toBeNull();
    expect(hexToHslTriplet('')).toBeNull();
  });
});
