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

import { parseMarkdownBody } from '@kamiazya/whiteboard-canvas-codec'
import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import {
  createBrowserMeasureText,
  ensureViewerFontLoaded,
} from '@kamiazya/whiteboard-canvas-viewer'
import { expect, it } from 'vitest'
import { renderCanvasToSvg } from '../components/spatial-editor/scene-render.js'
import type { LayoutRequest, LayoutResponse } from './layout-worker-protocol.js'

/** Every body the worker will be asked for, parsed the way the editor will. */
const bodiesOf = (c: SpatialCanvas) =>
  c.nodes
    .filter((n): n is Extract<typeof n, { type: 'text' }> => n.type === 'text')
    .map((n) => ({ text: n.text, mdast: parseMarkdownBody(n.text) }))

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
    bodies: bodiesOf(canvas),
  })

  expect(fromWorker.type).toBe('laid-out')
  if (fromWorker.type !== 'laid-out') return
  // SVG first: it is one string, so a mismatch names itself, where a deep
  // scene diff buries the difference in bbox noise.
  expect(fromWorker.svg).toBe(onMain.svg)
  expect(fromWorker.bounds).toEqual(onMain.bounds)
  expect(fromWorker.scene).toEqual(onMain.scene)
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
    resolveFileLabel: (file) => labels.find((l) => l.file === file)?.label,
  })
  const fromWorker = await layoutInWorker({
    type: 'layout',
    id: 2,
    canvas: withFile,
    theme: 'light',
    fileRefLabels: labels,
    bodies: bodiesOf(withFile),
  })
  expect(fromWorker.type).toBe('laid-out')
  if (fromWorker.type !== 'laid-out') return
  expect(fromWorker.svg).toContain('Readable name')
  expect(fromWorker.svg).toBe(onMain.svg)
}, 60_000)
