// Minimal export surface: this package is `private: true` (never published),
// but it still has no semver discipline of its own, so keep the surface
// intentionally small — display-only scene parsing/serialization plus the
// read-only viewer component and its imperative mount API.
export {
  excalidrawJsonDocSchema,
  viewerSceneSchema,
  parseViewerScene,
  serializeSceneAsExcalidrawJson,
} from './scene.js'
export type { ExcalidrawJsonDoc, ViewerScene } from './scene.js'
export { CanvasViewer } from './CanvasViewer.js'
export type { CanvasViewerProps } from './CanvasViewer.js'
export { mountCanvasViewer } from './mount.js'
export type { CanvasViewerHandle, MountCanvasViewerOptions } from './mount.js'
export { serializeSceneForScriptTag } from './widget/embed-scene.js'
