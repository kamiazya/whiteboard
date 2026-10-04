// Minimal export surface: this package is `private: true` (never published),
// but it still has no semver discipline of its own, so keep the surface
// intentionally small — display-only scene parsing/serialization plus the
// read-only viewer component and its imperative mount API.

export { CanvasViewer } from './CanvasViewer.js'
export { VIEWER_FONT_FAMILY } from './font.js'
export { withViewerFontEmbedded } from './font-embedding.js'
export { ensureViewerFontLoaded } from './font-loading.js'
export { createBrowserMeasureText } from './measure-text.js'
export { SceneSvg } from './SceneSvg.js'
