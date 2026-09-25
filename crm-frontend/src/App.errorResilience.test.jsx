import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * App.errorResilience.test.jsx — system-wide audit finding.
 *
 * Lead Detail's Owner-change crash (an uncaught render error unmounting the
 * WHOLE app) was possible on every route, not just Lead Detail — there was
 * no error boundary anywhere above any page. Lead Detail got its own
 * boundary as the direct fix; this locks down the app-wide one added during
 * the follow-up system audit so every route (Dashboard, Deals, Settings,
 * etc.) gets the same "never a permanently blank page" guarantee, and a
 * future contributor can't quietly remove it from PageContentWrapper.
 */
describe('every routed page is wrapped in an ErrorBoundary', () => {
  const src = fs.readFileSync(path.join(__dirname, 'App.jsx'), 'utf8');

  it('imports the shared ErrorBoundary component', () => {
    expect(src).toMatch(/import ErrorBoundary from ['"]\.\/components\/ErrorBoundary['"]/);
  });

  it('PageContentWrapper (used by every main route) wraps its children in ErrorBoundary, reset per route', () => {
    const wrapper = src.match(/const PageContentWrapper = \(\{ children \}\) => \{[\s\S]*?\n\};/);
    expect(wrapper).not.toBeNull();
    const body = wrapper[0];
    expect(body).toMatch(/<ErrorBoundary[\s\S]*?resetKey=\{location\.pathname\}/);
    expect(body).toMatch(/\{children\}/);
  });
});
