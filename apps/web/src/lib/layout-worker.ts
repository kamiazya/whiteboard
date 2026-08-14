/**
 * Lays a spatial canvas out off the main thread.
 *
 * Layout is the editor's longest synchronous block: measured on this
 * machine, 81ms for an ordinary 20-node/30-edge canvas and 339ms at
 * 60/200 — both past the ~50ms a person notices, and paid again on every
 * committed change (add a node, drop a drag, edit text). Moving it here does
 * not make it faster; it stops it freezing the UI.
 *
 * Markdown arrives already parsed (see the protocol's note): this module
 * never imports canvas-codec, so remark and unified stay out of the worker
 * chunk. A body nobody pre-parsed is answered with `failed` rather than an
 * empty paragraph — a slower frame is recoverable, a silently different scene
 * is not.
 *
 * The one thing that would make this WRONG is a scene that differs from what
 * the main thread would have produced. Text measurement is where that would
 * come from: a worker has its own `FontFaceSet`, so the vendored Roboto face
 * has to be registered HERE too or `measureText` silently falls back to a
 * system font and every wrapped line lands somewhere else.
 * `ensureViewerFontLoaded` handles both realms, and
 * `layout-worker-parity.browser.test.tsx` asserts the two scenes are deeply
 * equal rather than trusting that they are.
 */
// Subpath imports, not the package barrel: the barrel re-exports
// `CanvasViewer` and `mountCanvasViewer`, whose module graphs touch
// `document` on evaluation, and a worker has none — importing it throws
// `document is not defined` before a single message is handled.
import { ensureViewerFontLoaded } from '@kamiazya/whiteboard-canvas-viewer/font-loading'
import { createBrowserMeasureText } from '@kamiazya/whiteboard-canvas-viewer/measure-text'
import { renderCanvasToSvgWith } from '../components/spatial-editor/scene-render-core.js'
import type { LayoutRequest, LayoutResponse } from './layout-worker-protocol.js'

const measure = createBrowserMeasureText()

// Registration is idempotent and memoized inside the loader, but the FIRST
// request must wait for it: measuring before the face lands produces
// fallback metrics, which is exactly the divergence this worker must not
// introduce. Later requests await an already-settled promise.
const fontReady = ensureViewerFontLoaded()

self.onmessage = async (event: MessageEvent<LayoutRequest>) => {
  const request = event.data
  if (request.type !== 'layout') return
  try {
    await fontReady
    const labels = new Map((request.fileRefLabels ?? []).map((o) => [o.file, o.label]))
    const bodies = new Map(request.bodies.map((b) => [b.text, b.mdast]))
    let missing: string | undefined
    const { svg, bounds, scene } = renderCanvasToSvgWith(request.canvas, {
      measure,
      theme: request.theme,
      resolveFileLabel: labels.size === 0 ? undefined : (file) => labels.get(file),
      parseBody: (text: string) => {
        const parsed = bodies.get(text)
        if (parsed === undefined) {
          missing ??= text
          return { type: 'root', children: [] }
        }
        return parsed
      },
    })
    if (missing !== undefined) {
      const response: LayoutResponse = {
        type: 'failed',
        id: request.id,
        reason: `no pre-parsed body for ${JSON.stringify(missing.slice(0, 40))}`,
      }
      self.postMessage(response)
      return
    }
    const response: LayoutResponse = { type: 'laid-out', id: request.id, svg, bounds, scene }
    self.postMessage(response)
  } catch (error) {
    const response: LayoutResponse = {
      type: 'failed',
      id: request.id,
      reason: error instanceof Error ? error.message : String(error),
    }
    self.postMessage(response)
  }
}
