import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { CanvasViewer } from './CanvasViewer.js'
import { parseViewerScene } from './scene.js'

export interface MountCanvasViewerOptions {
  // Raw, unparsed scene payload — run through parseViewerScene so callers
  // (including the standalone widget entry) never have to import the
  // schema themselves. Falls back to the embedded-scene slot when absent.
  scene?: unknown
  width?: number
  height?: number
  testId?: string
  // Hand-off seam for embedding hosts (e.g. an MCP Apps widget iframe) to
  // receive postMessage traffic without this package owning any bridge
  // protocol. Registered on `window`, unbound by dispose(). Receives the
  // full MessageEvent (not just `.data`) so the host MUST inspect
  // `event.origin` / `event.source` itself before trusting the payload —
  // this package has no way to know the host's expected origin, so it
  // cannot filter on the host's behalf.
  messageHandler?: (event: MessageEvent) => void
}

export interface CanvasViewerHandle {
  dispose: () => void
}

/** Thrown by the imperative mount API when the scene payload fails schema validation. */
export class ViewerSceneError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ViewerSceneError'
  }
}

const EMBEDDED_SCENE_SCRIPT_SELECTOR = 'script[type="application/json"][data-whiteboard-scene]'

declare global {
  interface Window {
    __WHITEBOARD_VIEWER_SCENE__?: unknown
  }
}

// Two embedded-scene slots, checked in order: a <script> tag survives being
// served as static HTML (the single-file widget build), while the window
// global is the cheaper path for a host that already controls the document
// (e.g. constructing the iframe's document directly).
function readEmbeddedScene(): unknown {
  const script = document.querySelector(EMBEDDED_SCENE_SCRIPT_SELECTOR)
  if (script?.textContent) {
    return JSON.parse(script.textContent)
  }
  return window.__WHITEBOARD_VIEWER_SCENE__
}

export function mountCanvasViewer(
  container: HTMLElement,
  opts: MountCanvasViewerOptions = {},
): CanvasViewerHandle {
  // mountCanvasViewer is an imperative API boundary, so it converts
  // parseViewerScene's total-parser result into a thrown error here — the
  // internal builder/renderer stay total, but a caller of this entrypoint
  // gets the conventional throw-on-invalid-input shape.
  const result = parseViewerScene(opts.scene ?? readEmbeddedScene())
  if (!result.ok) {
    throw new ViewerSceneError(`${result.error.stage}: ${result.error.message}`)
  }
  const scene = result.value

  const root: Root = createRoot(container)
  // mountCanvasViewer is an imperative, synchronous-feeling API (the caller
  // queries the DOM right after calling it, e.g. a widget host reading
  // back layout). flushSync forces the initial commit to land before
  // mountCanvasViewer returns instead of leaving it scheduled.
  flushSync(() => {
    root.render(
      createElement(CanvasViewer, {
        canvas: scene,
        width: opts.width,
        height: opts.height,
        testId: opts.testId,
      }),
    )
  })

  const onMessage = opts.messageHandler
  if (onMessage) {
    window.addEventListener('message', onMessage)
  }

  return {
    dispose: () => {
      root.unmount()
      if (onMessage) {
        window.removeEventListener('message', onMessage)
      }
    },
  }
}
