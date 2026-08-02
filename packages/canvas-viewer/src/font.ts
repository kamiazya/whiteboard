/**
 * The single source of truth for the viewer's export font family. Consumed
 * by the browser `MeasureText` implementation (measure-text.ts), the
 * font-loading module that registers it as a real webfont
 * (font-loading.ts), and the widget's build-time font embedding
 * (widget/font-assets.ts) so all three never drift into two literal family
 * names.
 *
 * Naming the family is not enough on its own: Canvas 2D silently falls back
 * to a system font when no face is registered under the requested name, and
 * `document.fonts.check()` cannot detect that (it reports `true` for an
 * unloaded family). `ensureViewerFontLoaded()` (font-loading.ts) therefore
 * registers and loads the vendored `assets/fonts/Roboto/Roboto-Regular.ttf`
 * under this family name, and the executable guard is a browser test
 * asserting the measured width differs from a deliberately bogus family
 * (`CanvasViewer.browser.test.tsx`).
 *
 * That load is bounded, so it is NOT guaranteed to complete before the first
 * measurement: if the face has not arrived within the budget, first paint
 * proceeds with fallback metrics and a late arrival ticks the readiness
 * signal so mounted consumers re-measure. What holds unconditionally is the
 * family name; "the face is loaded" holds only once the loader has resolved
 * 'loaded'.
 *
 * mcp-server independently vendors the same face (byte-identical) under its
 * own `EXPORT_FONT_FAMILY` constant — the two packages cannot import each
 * other (see architecture-map.md), so this is a deliberate, documented
 * duplication: both sides must name the same font family ("Roboto") for
 * browser and Node export metrics to agree. A future font swap on either
 * side without updating the other silently desyncs metrics rather than
 * failing loudly.
 */
export const VIEWER_FONT_FAMILY = 'Roboto'
