/**
 * Lays a spatial canvas out off the main thread.
 *
 * Layout is the editor's longest synchronous block: measured on this
 * machine, 81ms for an ordinary 20-node/30-edge canvas and 339ms at
 * 60/200 — both past the ~50ms a person notices, and paid again on every
 * committed change (add a node, drop a drag, edit text). Moving it here does
 * not make it faster; it stops it freezing the UI.
 *
 * Markdown is parsed HERE, with the same `parseMarkdownBody` the main thread
 * uses, so the whole per-commit block — parse plus layout — leaves the main
 * thread. This is only possible because vite.config.ts pins
 * decode-named-character-reference to its DOM-free entry; without the alias
 * this chunk throws `document is not defined` before handling a message.
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
import {
  layoutMarkdownOutline,
  renderMarkdownPreview,
} from '../components/markdown-editor/render-preview.js'
import { renderCanvasToSvgWith } from '../components/spatial-editor/scene-render-core.js'
import {
  composeReferenceSeam,
  FONT_DEGRADED,
  type LayoutRequest,
  type LayoutResponse,
  type MarkdownRailRequest,
  type MarkdownRailResponse,
  type MarkdownRenderRequest,
  type MarkdownRenderResponse,
} from './layout-worker-protocol.js'

const measure = createBrowserMeasureText()

// Registration is idempotent and memoized inside the loader, but the FIRST
// request must wait for it: measuring before the face lands produces
// fallback metrics, which is exactly the divergence this worker must not
// introduce. Later requests await an already-settled promise.
const fontReady = ensureViewerFontLoaded()

self.onmessage = async (
  event: MessageEvent<LayoutRequest | MarkdownRailRequest | MarkdownRenderRequest>,
) => {
  const request = event.data
  if (request.type === 'markdown-render') {
    try {
      // Same font gate as the other two: a thumbnail measured with a system
      // face wraps its lines elsewhere and stops being a picture of the
      // document it labels.
      if ((await fontReady) !== 'loaded') {
        const failed: MarkdownRenderResponse = {
          type: 'failed',
          id: request.id,
          reason: FONT_DEGRADED,
        }
        self.postMessage(failed)
        return
      }
      const { svg, blocks } = renderMarkdownPreview(request.body, {
        measure,
        maxWidth: request.maxWidth,
      })
      // The preview's SVG carries its own viewBox; the caller needs the
      // extent to scale it, and the blocks already describe it.
      const right = Math.max(0, ...blocks.map((b) => b.x + b.w))
      const bottom = Math.max(0, ...blocks.map((b) => b.y + b.h))
      const done: MarkdownRenderResponse = {
        type: 'markdown-render-done',
        id: request.id,
        svg,
        bounds: { x: 0, y: 0, w: right, h: bottom },
      }
      self.postMessage(done)
    } catch (error) {
      const failed: MarkdownRenderResponse = {
        type: 'failed',
        id: request.id,
        reason: error instanceof Error ? error.message : String(error),
      }
      self.postMessage(failed)
    }
    return
  }
  if (request.type === 'markdown-rail') {
    try {
      // Same font gate as layout: measuring with a system face would put
      // every wrapped line somewhere else, and the rail's whole content is
      // where the lines land.
      if ((await fontReady) !== 'loaded') {
        const failed: MarkdownRailResponse = {
          type: 'failed',
          id: request.id,
          reason: FONT_DEGRADED,
        }
        self.postMessage(failed)
        return
      }
      const { blocks, anchors } = layoutMarkdownOutline(request.body, {
        measure,
        maxWidth: request.maxWidth,
      })
      const done: MarkdownRailResponse = {
        type: 'markdown-rail-done',
        id: request.id,
        blocks,
        anchors,
      }
      self.postMessage(done)
    } catch (error) {
      const failed: MarkdownRailResponse = {
        type: 'failed',
        id: request.id,
        reason: error instanceof Error ? error.message : String(error),
      }
      self.postMessage(failed)
    }
    return
  }
  if (request.type !== 'layout') return
  try {
    // Verified present in Chromium, WebKit and Firefox — but Playwright's
    // WebKit is not Safari, and a browser version that lacks a worker
    // `FontFaceSet` would measure with a system font and produce a scene that
    // disagrees with an export of the same canvas. Refusing is the only safe
    // answer: the caller lays it out on the main thread, where the face is
    // known to be loaded.
    if ((await fontReady) !== 'loaded') {
      const response: LayoutResponse = { type: 'failed', id: request.id, reason: FONT_DEGRADED }
      self.postMessage(response)
      return
    }
    const labels = new Map((request.fileRefLabels ?? []).map((o) => [o.file, o.label]))
    const missingRefs = new Set(request.missingFileRefs ?? [])
    const { svg, bounds, scene, anchors } = renderCanvasToSvgWith(request.canvas, {
      measure,
      theme: request.theme,
      resolveReference: composeReferenceSeam({ labels, missing: missingRefs }),
    })
    const response: LayoutResponse = {
      type: 'laid-out',
      id: request.id,
      svg,
      bounds,
      scene,
      anchors,
    }
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
