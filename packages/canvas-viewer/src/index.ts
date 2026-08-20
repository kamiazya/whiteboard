// Minimal export surface: this package is `private: true` (never published),
// but it still has no semver discipline of its own, so keep the surface
// intentionally small — display-only scene parsing/serialization plus the
// read-only viewer component and its imperative mount API.

export type { CanvasViewerProps } from './CanvasViewer.js'
export { CanvasViewer } from './CanvasViewer.js'
export { VIEWER_FONT_FAMILY } from './font.js'
export { withViewerFontEmbedded } from './font-embedding.js'
export { ensureViewerFontLoaded, type ViewerFontStatus } from './font-loading.js'
export { createBrowserMeasureText } from './measure-text.js'
export type { CanvasViewerHandle, MountCanvasViewerOptions } from './mount.js'
export { mountCanvasViewer, ViewerSceneError } from './mount.js'
export type { ViewerScene } from './scene.js'
export { parseViewerScene, serializeViewerScene, viewerSceneSchema } from './scene.js'
export { useViewerFontReady } from './use-viewer-font-ready.js'
export { serializeSceneForScriptTag } from './widget/embed-scene.js'
