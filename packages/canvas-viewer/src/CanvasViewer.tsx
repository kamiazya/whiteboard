import { Excalidraw } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import type { ViewerScene } from './scene.js'

export interface CanvasViewerProps {
  scene: ViewerScene
  width?: number | string
  height?: number | string
  // Hides Excalidraw's own persistent chrome (top-left menu, bottom-left
  // zoom controls, footer) for a clean-canvas capture. Pan/zoom/select stay
  // interactive either way — only editing affordances are locked via
  // viewModeEnabled + UIOptions below.
  hideChrome?: boolean
  // The chrome-hiding <style> below is scoped by this data-testid via a
  // plain CSS attribute selector, which is NOT DOM-subtree scoped. Callers
  // that mount more than one CanvasViewer in the same document MUST pass
  // distinct testIds, or a hideChrome on one instance leaks its
  // chrome-hiding rule onto every sibling still using the default.
  testId?: string
}

const DEFAULT_TEST_ID = 'canvas-viewer'

// Every canvasActions flag explicitly disabled (rather than omitted) so a
// future Excalidraw upgrade that adds a new default-on action does not
// silently reopen an edit affordance on a read-only viewer.
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

export function CanvasViewer({
  scene,
  width = '100%',
  height = '100%',
  hideChrome = false,
  testId = DEFAULT_TEST_ID,
}: CanvasViewerProps) {
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
    <div data-testid={testId} style={{ width, height, overflow: 'hidden' }}>
      {chromeStyle && <style>{chromeStyle}</style>}
      <Excalidraw
        viewModeEnabled
        zenModeEnabled={hideChrome}
        UIOptions={READ_ONLY_UI_OPTIONS}
        initialData={{
          // Excalidraw's own types want mutable arrays/records internally;
          // the parsed scene is read-only by contract, so cast rather than
          // copy — the component never mutates what it's handed.
          elements: scene.elements as never,
          appState: {
            viewBackgroundColor: '#ffffff',
            ...scene.appState,
          } as never,
          files: scene.files as never,
          scrollToContent: true,
        }}
      />
    </div>
  )
}
