// Helper component shared by the *.docs-snapshot.test.tsx files that
// render an Excalidraw scene to a PNG. Wraps Excalidraw in a fixed-size,
// view-only container so screenshots are deterministic regardless of the
// browser's actual viewport.

import { Excalidraw } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'

export interface ScenePreviewProps {
  width: number
  height: number
  elements: ReadonlyArray<unknown>
  appState?: Record<string, unknown>
  files?: Record<string, unknown>
  // When true, hides the floating toolbar / library / footer chrome so the
  // capture is a clean canvas. Default true (most doc images are content
  // shots, not UI shots).
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
  const chromeStyle = hideChrome
    ? `
      [data-testid="${testId}"] .App-menu,
      [data-testid="${testId}"] .App-bottom-bar,
      [data-testid="${testId}"] .layer-ui__wrapper__footer,
      [data-testid="${testId}"] .Island.App-menu_top__left,
      [data-testid="${testId}"] .Island.App-menu_bottom,
      [data-testid="${testId}"] .Stack.zen-mode-transition,
      [data-testid="${testId}"] .help-icon,
      [data-testid="${testId}"] .scroll-back-to-content { display: none !important; }
    `
    : null
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
      {chromeStyle && <style>{chromeStyle}</style>}
      <Excalidraw
        viewModeEnabled={viewOnly}
        zenModeEnabled={viewOnly}
        UIOptions={
          viewOnly
            ? {
                canvasActions: {
                  changeViewBackgroundColor: false,
                  clearCanvas: false,
                  export: false,
                  loadScene: false,
                  saveAsImage: false,
                  saveToActiveFile: false,
                  toggleTheme: false,
                },
              }
            : undefined
        }
        initialData={{
          // Excalidraw expects mutable arrays internally; cast away the
          // readonly so the prop type aligns without copying.
          elements: elements as never,
          appState: {
            viewBackgroundColor: '#ffffff',
            ...(appState ?? {}),
          } as never,
          files: (files ?? {}) as never,
          scrollToContent: true,
        }}
      />
    </div>
  )
}
