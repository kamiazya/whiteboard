import { VIEWER_FONT_FAMILY } from '../font.js'
import type { WidgetFontAsset } from './build-fonts-module.js'

// Roboto Regular (Apache-2.0), vendored under packages/canvas-viewer/assets/
// fonts/Roboto — this package cannot import mcp-server's own vendored copy
// across the package boundary (see architecture-map.md), so both sides carry
// their own copy of the same face. VIEWER_FONT_FAMILY (font.ts) is the single
// constant that keeps this asset's `family` and the browser measurer's
// requested family from drifting into two literal strings.
export const WIDGET_FONT_ASSETS: readonly WidgetFontAsset[] = [
  {
    family: VIEWER_FONT_FAMILY,
    file: 'Roboto/Roboto-Regular.ttf',
  },
]
