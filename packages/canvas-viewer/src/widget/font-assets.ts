import type { WidgetFontAsset } from './build-fonts-module.js'

// Excalifont is FONT_FAMILY.Excalifont, Excalidraw's default hand-drawn text
// family (used for any element that doesn't request Normal/Code explicitly).
// This is the only family the viewer's embedded-scene sample and the
// widget-smoke fixture render, so it is the only one the widget needs to
// carry — a new consumer scene that opts into a different font family would
// need its variant added here too.
//
// The unicode-range below is the Basic-Latin/Latin-1-supplement subset
// straight out of @excalidraw/excalidraw's own font metadata (see
// dist/prod/chunk-*.js) — matching it exactly means document.fonts.check()
// behaves the same as it would against the upstream CDN-hosted font.
export const WIDGET_FONT_ASSETS: readonly WidgetFontAsset[] = [
  {
    family: 'Excalifont',
    file: 'Excalifont/Excalifont-Regular-a88b72a24fb54c9f94e3b5fdaa7481c9.woff2',
    unicodeRange:
      'U+20-7e,U+a0-a3,U+a5-a6,U+a8-ab,U+ad-b1,U+b4,U+b6-b8,U+ba-ff,U+131,U+152-153,U+2bc,U+2c6,U+2da,U+2dc,U+304,U+308,U+2013-2014,U+2018-201a,U+201c-201e,U+2020,U+2022,U+2024-2026,U+2030,U+2039-203a,U+20ac,U+2122,U+2212',
  },
]
