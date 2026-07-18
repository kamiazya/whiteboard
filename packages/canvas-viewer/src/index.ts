// Minimal export surface: this package is `private: true` (never published),
// but it still has no semver discipline of its own, so keep the surface
// intentionally small — display-only scene parsing/serialization. A future
// <CanvasViewer> / mountCanvasViewer mount API lands as a separate increment.
export {
  excalidrawJsonDocSchema,
  viewerSceneSchema,
  parseViewerScene,
  serializeSceneAsExcalidrawJson,
} from './scene.js'
export type { ExcalidrawJsonDoc, ViewerScene } from './scene.js'
