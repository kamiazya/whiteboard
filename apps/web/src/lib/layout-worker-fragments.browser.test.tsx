// Math and diagram fragments cross to the worker as rendered strings: a
// request without them is laid out with the fallback and reports what it
// asked for, and the same request carrying them draws them — the content
// cache included, since a body memoised while its fragment was missing
// must not keep drawing the fallback.

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { afterAll, expect, it } from 'vitest'
import type { FragmentEntry } from './fragment-requests.js'
import type { LayoutRequest, LayoutResponse } from './layout-worker-protocol.js'

const board: SpatialCanvas = {
  nodes: [textNode({ id: 'a', x: 0, y: 0, width: 240, height: 160, text: '$$\nx^2\n$$\n' })],
  edges: [],
}

const FRAGMENT: FragmentEntry = [
  'math:x^2',
  { svg: '<g data-probe="worker-typeset"/>', width: 40, height: 10 },
]

const worker = new Worker(new URL('./layout-worker.ts', import.meta.url), { type: 'module' })
afterAll(() => worker.terminate())

let nextId = 1
function layout(fragments?: readonly FragmentEntry[]): Promise<LayoutResponse> {
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
      canvas: board,
      theme: 'light',
      ...(fragments === undefined ? {} : { fragments }),
    }
    worker.postMessage(request)
  })
}

it('reports the math a layout asked for, then draws it once the request carries it', async () => {
  const bare = await layout()
  if (bare.type !== 'laid-out') throw new Error(`worker failed: ${bare.reason}`)
  expect(bare.svg).not.toContain('worker-typeset')
  expect(bare.fragmentsAsked).toEqual([{ kind: 'math', value: 'x^2' }])
  const typeset = await layout([FRAGMENT])
  if (typeset.type !== 'laid-out') throw new Error(`worker failed: ${typeset.reason}`)
  expect(typeset.svg).toContain('worker-typeset')
  expect(typeset.fragmentsAsked).toBeUndefined()
}, 20_000)
