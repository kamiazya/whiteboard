// Helper component shared by the *.docs-snapshot.test.tsx files that
// render an Excalidraw scene to a PNG. Wraps the shared read-only
// <CanvasViewer> in a fixed-size container so screenshots are deterministic
// regardless of the browser's actual viewport.

import { CanvasViewer, parseViewerScene } from '@kamiazya/whiteboard-canvas-viewer'

export interface ScenePreviewProps {
  width: number
  height: number
  elements: ReadonlyArray<unknown>
  appState?: Record<string, unknown>
  files?: Record<string, unknown>
  // CanvasViewer is always read-only; kept for call-site back-compat, but
  // no doc image has ever needed an editable preview.
  viewOnly?: boolean
  // When true, also hides Excalidraw's own persistent UI (top-left menu,
  // bottom-left zoom controls). Useful for diagram-only doc images;
  // disable for hero shots where the chrome is part of the story.
  hideChrome?: boolean
  // Marker id used by tests so they can wait for the wrapper to mount.
  testId?: string
}

export function ScenePreview({
  width,
  height,
  elements,
  appState,
  files,
  viewOnly = true,
  hideChrome = false,
  testId = 'scene-preview',
}: ScenePreviewProps) {
  if (!viewOnly) {
    throw new Error('ScenePreview no longer supports viewOnly={false}; CanvasViewer is read-only')
  }

  const scene = parseViewerScene({
    elements,
    appState: { viewBackgroundColor: '#ffffff', ...(appState ?? {}) },
    files: files ?? {},
  })

  return (
    <div
      data-testid={testId}
      style={{
        width: `${width}px`,
        height: `${height}px`,
        background: '#ffffff',
        overflow: 'hidden',
      }}
    >
      <CanvasViewer scene={scene} hideChrome={hideChrome} testId={testId} />
    </div>
  )
}
