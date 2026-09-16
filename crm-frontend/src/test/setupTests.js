import '@testing-library/jest-dom/vitest';

// jsdom has no ResizeObserver — Leaflet/react-leaflet reference it during
// map sizing. A minimal stub is enough for render-only tests (no real
// layout assertions rely on it).
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
