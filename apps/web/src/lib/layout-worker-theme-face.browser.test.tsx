// A theme's family reaches the WORKER the way it reaches the main thread:
// as bytes, registered in the worker's own face set. Until it lands the
// worker declares the bundled family — and afterwards the theme's, which
// is the parity `fontAvailable` promises between the two realms.
//
// A real browser: the subject is a Worker's FontFaceSet.
import { withViewerFontEmbedded } from '@kamiazya/whiteboard-canvas-viewer'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { afterAll, expect, it } from 'vitest'
import type { LayoutResponse, RegisterFaceRequest } from './layout-worker-protocol.js'

const sketched: SpatialCanvas = {
  nodes: [{ id: 'g', type: 'group', x: 0, y: 0, width: 300, height: 200, label: 'Keepers' }],
  edges: [],
  'x-whiteboard': { facets: { 'visual.theme/v0': { theme: 'visual.sketch' } } },
}

const worker = new Worker(new URL('./layout-worker.ts', import.meta.url), { type: 'module' })
afterAll(() => worker.terminate())

let nextId = 1
function layout(): Promise<LayoutResponse> {
  const id = nextId++
  return new Promise((resolve) => {
    const onMessage = (event: MessageEvent<LayoutResponse>) => {
      if (event.data.id !== id) return
      worker.removeEventListener('message', onMessage)
      resolve(event.data)
    }
    worker.addEventListener('message', onMessage)
    worker.postMessage({ type: 'layout', id, canvas: sketched, theme: 'light' })
  })
}

it('declares the bundled family until the theme face lands, and the theme family after', async () => {
  const before = await layout()
  expect(before.type).toBe('laid-out')
  if (before.type !== 'laid-out') return
  expect(before.svg).toContain('font-family="Roboto"')
  expect(before.svg).not.toContain('Yomogi')

  // Any real font file will do for the worker's face set; the vendored one
  // is the bytes this app can always reach. Registered under the family the
  // sketch theme names.
  const embedded = await withViewerFontEmbedded('<svg xmlns="http://www.w3.org/2000/svg"></svg>')
  const uri = /src:url\('(data:font\/ttf;base64,[^']+)'\)/.exec(embedded)?.[1]
  expect(uri).toBeDefined()
  const bytes = await (await fetch(uri as string)).arrayBuffer()
  const register: RegisterFaceRequest = { type: 'register-face', family: 'Yomogi', bytes }
  worker.postMessage(register)

  const after = await layout()
  expect(after.type).toBe('laid-out')
  if (after.type !== 'laid-out') return
  expect(after.svg).toContain('font-family="Yomogi"')
}, 20_000)
