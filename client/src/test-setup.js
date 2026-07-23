// Global Vitest setup. Runs before every test file, in both the node and
// jsdom environments, so anything here must be guarded for the case where
// there is no DOM.
//
// jsdom does not implement window.matchMedia, but several react-bootstrap
// components call it — e.g. Offcanvas's useBreakpoint hook (used by the
// authenticated Layout's mobile nav drawer). Without this stub, mounting them
// under `@vitest-environment jsdom` throws "matchMedia is not a function".
// The service-layer suites run in the plain node environment (no `window`),
// where the guard makes this a no-op.
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = (query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}
