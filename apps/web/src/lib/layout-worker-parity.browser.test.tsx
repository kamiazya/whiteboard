/**
 * The scene a worker produces must be the scene the main thread would have
 * produced. This package's own rule is "one producer per geometry, or a
 * parity test" — moving layout off the main thread creates a second producer,
 * so this is that test.
 *
 * The failure it exists to catch is silent: a worker has its own
 * `FontFaceSet`, and Canvas 2D falls back to a system font when the requested
 * family is not registered without reporting it. Metrics would differ by a
 * fraction of a pixel, lines would wrap elsewhere, and the editor would
 * disagree with an export of the same canvas — the divergence class
 * canvas-viewer's font.ts already documents having shipped once.
 */

import {
  createBrowserMeasureText,
  ensureViewerFontLoaded,
} from '@kamiazya/whiteboard-canvas-viewer'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { expect, it } from 'vitest'
import { renderMarkdownPreview } from '../components/markdown-editor/render-preview.js'
import { renderCanvasToSvg } from '../components/spatial-editor/scene-render.js'
import type {
  LayoutRequest,
  LayoutResponse,
  MarkdownRenderRequest,
  MarkdownRenderResponse,
} from './layout-worker-protocol.js'

// Text that wraps, punctuation that kerns, and a mix of scripts: measurement
// differences show up in wrapped-line counts, not in a single short word.
const canvas: SpatialCanvas = {
  nodes: [
    {
      id: 'a',
      type: 'text',
      x: 0,
      y: 0,
      width: 220,
      height: 140,
      text: 'The quick brown fox jumps over the lazy dog, and then it keeps going.',
    },
    {
      id: 'b',
      type: 'text',
      x: 320,
      y: 40,
      width: 200,
      height: 120,
      text: 'あいうえお かきくけこ',
    },
    {
      id: 'c',
      type: 'text',
      x: 120,
      y: 280,
      width: 240,
      height: 110,
      text: 'Wide WWW vs narrow iii',
    },
    { id: 'g', type: 'group', x: -20, y: -20, width: 580, height: 440, label: 'group' },
  ],
  edges: [
    { id: 'e1', fromNode: 'a', toNode: 'b', label: 'edge label' },
    { id: 'e2', fromNode: 'b', toNode: 'c' },
    { id: 'e3', fromNode: 'a', toNode: 'c' },
  ],
  'x-whiteboard': { edgeRouting: { style: 'orthogonal' } },
} as SpatialCanvas

const layoutInWorker = (request: LayoutRequest) =>
  new Promise<LayoutResponse>((resolve, reject) => {
    const worker = new Worker(new URL('./layout-worker.ts', import.meta.url), { type: 'module' })
    const timer = setTimeout(() => reject(new Error('layout worker timed out')), 30_000)
    worker.onmessage = (e: MessageEvent<LayoutResponse>) => {
      clearTimeout(timer)
      worker.terminate()
      resolve(e.data)
    }
    worker.onerror = (e) => {
      clearTimeout(timer)
      worker.terminate()
      reject(new Error(`layout worker error: ${e.message}`))
    }
    worker.postMessage(request)
  })

it('the worker scene is deeply equal to the main-thread scene', async () => {
  // The main thread measures with the real face or the test proves nothing:
  // two fallbacks also agree with each other.
  expect(await ensureViewerFontLoaded()).toBe('loaded')

  const onMain = renderCanvasToSvg(canvas, { measure: createBrowserMeasureText(), theme: 'light' })
  const fromWorker = await layoutInWorker({
    type: 'layout',
    id: 1,
    canvas,
    theme: 'light',
  })

  expect(fromWorker.type).toBe('laid-out')
  if (fromWorker.type !== 'laid-out') return
  // SVG first: it is one string, so a mismatch names itself, where a deep
  // scene diff buries the difference in bbox noise.
  expect(fromWorker.svg).toBe(onMain.svg)
  expect(fromWorker.bounds).toEqual(onMain.bounds)
  expect(fromWorker.scene).toEqual(onMain.scene)
  // The anchor map crosses as a structuredClone'd Map; the drag overlay pins
  // bystander edges to it, so a worker that dropped or reordered entries
  // would silently re-fraction shared anchor groups mid-drag.
  expect([...fromWorker.anchors.entries()]).toEqual([...onMain.anchors.entries()])
}, 60_000)

it('carries the file-label seam across the wire', async () => {
  const withFile: SpatialCanvas = {
    nodes: [{ id: 'f', type: 'file', x: 0, y: 0, width: 200, height: 100, file: 'doc-1' }],
    edges: [],
  } as SpatialCanvas
  const labels = [{ file: 'doc-1', label: 'Readable name' }]
  const onMain = renderCanvasToSvg(withFile, {
    measure: createBrowserMeasureText(),
    theme: 'light',
    resolveReference: (ref) => {
      const label = labels.find((l) => l.file === ref)?.label
      return label === undefined ? undefined : { label }
    },
  })
  const fromWorker = await layoutInWorker({
    type: 'layout',
    id: 2,
    canvas: withFile,
    theme: 'light',
    fileRefLabels: labels,
  })
  expect(fromWorker.type).toBe('laid-out')
  if (fromWorker.type !== 'laid-out') return
  expect(fromWorker.svg).toContain('Readable name')
  expect(fromWorker.svg).toBe(onMain.svg)
}, 60_000)

it('parses markdown itself — no pre-parsed bodies cross the wire', async () => {
  // The named character reference is the load-bearing detail: decoding it
  // walks decode-named-character-reference, whose `browser` entry touches
  // `document` at module top level and killed any worker importing remark
  // until the vite alias pinned the worker-safe entry. A worker that cannot
  // parse — or cannot even evaluate its chunk — fails this case loudly.
  expect(await ensureViewerFontLoaded()).toBe('loaded')
  const withMarkdown: SpatialCanvas = {
    nodes: [
      {
        id: 'm',
        type: 'text',
        x: 0,
        y: 0,
        width: 240,
        height: 140,
        text: '# Ampersands &amp; entities\n\nSome *emphasis* to lay out.',
      },
    ],
    edges: [],
  } as SpatialCanvas
  const onMain = renderCanvasToSvg(withMarkdown, {
    measure: createBrowserMeasureText(),
    theme: 'light',
  })
  const fromWorker = await layoutInWorker({
    type: 'layout',
    id: 3,
    canvas: withMarkdown,
    theme: 'light',
  })
  expect(fromWorker.type).toBe('laid-out')
  if (fromWorker.type !== 'laid-out') return
  expect(fromWorker.svg).toBe(onMain.svg)
}, 60_000)

const renderMarkdownInWorker = (request: MarkdownRenderRequest) =>
  new Promise<MarkdownRenderResponse>((resolve, reject) => {
    const worker = new Worker(new URL('./layout-worker.ts', import.meta.url), { type: 'module' })
    const timer = setTimeout(() => reject(new Error('markdown render timed out')), 15_000)
    worker.onmessage = (e: MessageEvent<MarkdownRenderResponse>) => {
      clearTimeout(timer)
      worker.terminate()
      resolve(e.data)
    }
    worker.onerror = (e) => {
      clearTimeout(timer)
      worker.terminate()
      reject(new Error(`markdown render error: ${e.message}`))
    }
    worker.postMessage(request)
  })

// A row thumbnail is the same picture the preview pane draws, only smaller,
// so a worker that measured with a different face would put every wrapped
// line somewhere else and the thumbnail would stop being that document.
it('the worker markdown SVG is the main-thread markdown SVG', async () => {
  expect(await ensureViewerFontLoaded()).toBe('loaded')
  const body =
    '# Title\n\nA paragraph that is long enough to wrap at the width below, plus あいうえお.\n\n- one\n- two\n'

  const onMain = renderMarkdownPreview(body, {
    measure: createBrowserMeasureText(),
    maxWidth: 640,
  })
  const fromWorker = await renderMarkdownInWorker({
    type: 'markdown-render',
    id: 9,
    body,
    maxWidth: 640,
  })

  expect(fromWorker.type).toBe('markdown-render-done')
  if (fromWorker.type !== 'markdown-render-done') return
  expect(fromWorker.svg).toBe(onMain.svg)
  expect(fromWorker.bounds.w).toBeGreaterThan(0)
  expect(fromWorker.bounds.h).toBeGreaterThan(0)
}, 60_000)
