// Helper component shared by the *.docs-snapshot.test.tsx files that render
// an Excalidraw scene to a PNG.
//
// This inlines the read-only Excalidraw wrapper that used to live in
// @kamiazya/whiteboard-canvas-viewer's <CanvasViewer>. That package was
// rebuilt in Phase 2 of the OpenCanvas migration to render canvas-render's
// SVG output instead of hosting the Excalidraw component, so it no longer has
// an Excalidraw-scene entrypoint for this file to call. Repointing doc
// screenshots at the new OpenCanvas viewer would invalidate every committed
// PNG under docs/assets/ and pull in that regeneration workflow as a side
// effect of an unrelated package rebuild — out of scope here. This wrapper is
// deliberately temporary: it goes away once the apps/web editor itself
// migrates off Excalidraw (a later phase).
import { Excalidraw } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'

export interface ScenePreviewProps {
  width: number
  height: number
  elements: ReadonlyArray<unknown>
  appState?: Record<string, unknown>
  files?: Record<string, unknown>
  // Kept for call-site back-compat; this wrapper is always read-only.
  viewOnly?: boolean
  // When true, also hides Excalidraw's own persistent UI (top-left menu,
  // bottom-left zoom controls). Useful for diagram-only doc images;
  // disable for hero shots where the chrome is part of the story.
  hideChrome?: boolean
  // Marker id used by tests so they can wait for the wrapper to mount.
  testId?: string
}

const DEFAULT_TEST_ID = 'scene-preview'

// Every canvasActions flag explicitly disabled (rather than omitted) so a
// future Excalidraw upgrade that adds a new default-on action does not
// silently reopen an edit affordance on a read-only preview.
const READ_ONLY_UI_OPTIONS = {
  canvasActions: {
    changeViewBackgroundColor: false,
    clearCanvas: false,
    export: false,
    loadScene: false,
    saveAsImage: false,
    saveToActiveFile: false,
    toggleTheme: false,
  },
} as const

export function ScenePreview({
  width,
  height,
  elements,
  appState,
  files,
  viewOnly = true,
  hideChrome = false,
  testId = DEFAULT_TEST_ID,
}: ScenePreviewProps) {
  if (!viewOnly) {
    throw new Error('ScenePreview no longer supports viewOnly={false}; CanvasViewer is read-only')
  }

  // Interpolated into a <style> block below; restrict to a safe identifier
  // charset so no prop value can break out of the attribute selector.
  const safeTestId = /^[A-Za-z0-9_-]+$/.test(testId) ? testId : DEFAULT_TEST_ID
  const chromeStyle = hideChrome
    ? `
      [data-testid="${safeTestId}"] .App-menu,
      [data-testid="${safeTestId}"] .App-bottom-bar,
      [data-testid="${safeTestId}"] .layer-ui__wrapper__footer,
      [data-testid="${safeTestId}"] .Island.App-menu_top__left,
      [data-testid="${safeTestId}"] .Island.App-menu_bottom,
      [data-testid="${safeTestId}"] .Stack.zen-mode-transition,
      [data-testid="${safeTestId}"] .help-icon,
      [data-testid="${safeTestId}"] .scroll-back-to-content { display: none !important; }
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
        viewModeEnabled
        zenModeEnabled={hideChrome}
        UIOptions={READ_ONLY_UI_OPTIONS}
        initialData={{
          elements: elements as never,
          appState: {
            viewBackgroundColor: '#ffffff',
            ...appState,
          } as never,
          files: files as never,
          scrollToContent: true,
        }}
      />
    </div>
  )
}
