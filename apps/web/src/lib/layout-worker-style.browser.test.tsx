// The session override crosses to the worker as data: a layout request
// carrying `style` is laid out in that look, and one without it in the
// document's — the same default the main thread's composition takes.
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { afterAll, expect, it } from 'vitest'
import type { LayoutRequest, LayoutResponse } from './layout-worker-protocol.js'

const BODY = 'A body long enough to wrap over a couple of lines inside the box.'

const neon: SpatialCanvas = {
  nodes: [
    { id: 'a', type: 'text', x: 0, y: 0, width: 240, height: 160, text: BODY },
    { id: 'b', type: 'text', x: 300, y: 200, width: 120, height: 60, text: 'b' },
  ],
  edges: [{ id: 'e', fromNode: 'a', toNode: 'b' }],
  'x-whiteboard': { facets: { 'visual.theme/v0': { theme: 'visual.neon' } } },
}

const worker = new Worker(new URL('./layout-worker.ts', import.meta.url), { type: 'module' })
afterAll(() => worker.terminate())

let nextId = 1
function layout(style?: LayoutRequest['style']): Promise<LayoutResponse> {
  const id = nextId++
  return new Promise((resolve) => {
    const onMessage = (event: MessageEvent<LayoutResponse>) => {
      if (event.data.id !== id) return
      worker.removeEventListener('message', onMessage)
      resolve(event.data)
    }
    worker.addEventListener('message', onMessage)
    const request: LayoutRequest = {
      type: 'layout',
      id,
      canvas: neon,
      theme: 'light',
      ...(style === undefined ? {} : { style }),
    }
    worker.postMessage(request)
  })
}

it("draws the document's theme by default and the override when the request carries one", async () => {
  const themed = await layout()
  expect(themed.type === 'laid-out' && themed.svg.includes('wb-glow')).toBe(true)
  const clean = await layout('clean')
  expect(clean.type === 'laid-out' && !clean.svg.includes('wb-glow')).toBe(true)
  const sketch = await layout('visual.sketch')
  expect(sketch.type === 'laid-out' && sketch.svg.includes('stroke-linecap="round"')).toBe(true)
}, 20_000)

// Both caches under one worker: the store it picks per request, and
// canvas-render's body memo inside it. A body laid out clean first must not
// come back as the themed one's, which is what toggling Draw as does.
it("lays a body out again when the look changes, in the new look's ink", async () => {
  const clean = await layout('clean')
  expect(clean.type === 'laid-out' && clean.svg.includes('#404040')).toBe(true)
  const themed = await layout('document')
  // visual.neon's light labelFill; the bundled light palette paints #404040.
  expect(themed.type === 'laid-out' && themed.svg.includes('#0f172a')).toBe(true)
  expect(themed.type === 'laid-out' && themed.svg.includes('#404040')).toBe(false)
}, 20_000)
