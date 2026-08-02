/**
 * The single source of truth for the viewer's export font family. Consumed
 * by the browser `MeasureText` implementation (measure-text.ts), the
 * font-loading module that registers it as a real webfont
 * (font-loading.ts), and the widget's build-time font embedding
 * (widget/font-assets.ts) so all three never drift into two literal family
 * names.
 *
 * Naming this family was never the problem — until font-loading.ts landed,
 * nothing ever loaded a face under this name, so Canvas 2D silently fell
 * back to a system font while requesting "Roboto" (`document.fonts.check()`
 * reports `true` for an unloaded family and cannot detect this — see
 * font-loading.ts's own doc comment). The invariant that actually holds
 * today is: `ensureViewerFontLoaded()` has registered and loaded the
 * vendored `assets/fonts/Roboto/Roboto-Regular.ttf` under this family name
 * before layout measures anything, and `measure-text.browser.test.tsx` /
 * `CanvasViewer.browser.test.tsx` assert the measured width differs from a
 * deliberately bogus family — the executable guard against silent fallback.
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
