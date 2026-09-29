/**
 * brandColor — converts an admin-entered hex color (company_settings.
 * brand_primary_color — PRODUCTIZATION PHASE 2) into the "H S% L%" triplet
 * format the shadcn/ui CSS variables (--primary, see index.css) expect.
 *
 * Never throws: an invalid/malformed hex string returns null, so the caller
 * can safely no-op and leave the product-default --primary value in place —
 * same "static default, upgrade only on proven success" discipline as
 * Layout.jsx's logo/favicon loading (a prior DB-driven branding attempt broke
 * production by having no fallback on a bad value — see CLAUDE.md).
 */
const HEX_RE = /^#?([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/;

export function hexToHslTriplet(hex) {
  if (typeof hex !== 'string') return null;
  const m = hex.trim().match(HEX_RE);
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let hue = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: hue = ((g - b) / d + (g < b ? 6 : 0)); break;
      case g: hue = (b - r) / d + 2; break;
      default: hue = (r - g) / d + 4;
    }
    hue *= 60;
  }
  return `${Math.round(hue)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`;
}
