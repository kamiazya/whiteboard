import { parseMarkdownBody } from '@kamiazya/whiteboard-codec'
import type { CommentThread, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import type { SceneNode } from '@kamiazya/whiteboard-scene'
import { describe, expect, it } from 'vitest'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import { createSpatialTheme } from '../theme/spatial-theme.js'
import { layoutSpatialCanvas, type SpatialLayoutOptions } from './spatial-canvas.js'

const measure = createFakeMeasure()
const base: SpatialLayoutOptions = {
  measure,
  parseBody: parseMarkdownBody,
  appearance: createSpatialTheme({ mode: 'light' }),
}

const NOTE = textNode({ id: 'n1', x: 0, y: 0, width: 400, height: 100, text: 'ship the plan' })
const threads: readonly CommentThread[] = [
  {
    id: 't1',
    anchor: { kind: 'text', nodeId: 'n1', quote: { exact: 'plan' }, start: 0, end: 1 },
    status: 'open',
    messages: [{ id: 'm1', body: 'about it' }],
  },
  {
    id: 't2',
    anchor: { kind: 'spatial', nodeIds: ['n1'] },
    status: 'open',
    messages: [{ id: 'm2', body: 'region' }],
  },
] as unknown as readonly CommentThread[]
const comments = [{ id: 'c1', x: 500, y: 60, text: 'a card' }]
const withComments: SpatialCanvas = { nodes: [NOTE], edges: [], comments }
const without: SpatialCanvas = { nodes: [NOTE], edges: [] }

const chromeIds = (nodes: readonly SceneNode[]) =>
  nodes.flatMap((n) => (n.kind === 'shape' && n.commentChrome === true ? [n.id] : []))

describe('the commentLayer option', () => {
  it('draws pins, cards, outlines and highlights by default', () => {
    const scene = layoutSpatialCanvas(withComments, { ...base, threads })
    expect(chromeIds(scene.nodes).length).toBeGreaterThan(0)
  })

  it('draws none of the comment chrome when switched off, envelope comments included', () => {
    const scene = layoutSpatialCanvas(withComments, { ...base, threads, commentLayer: false })
    expect(chromeIds(scene.nodes)).toEqual([])
  })

  it('leaves a board without comments byte-identical either way', () => {
    const on = layoutSpatialCanvas(without, base)
    const off = layoutSpatialCanvas(without, { ...base, commentLayer: false })
    expect(JSON.stringify(off)).toBe(JSON.stringify(on))
  })

  it('leaves the content of a commented board as the uncommented board lays it out', () => {
    const off = layoutSpatialCanvas(withComments, { ...base, threads, commentLayer: false })
    const plain = layoutSpatialCanvas(without, base)
    expect(JSON.stringify(off)).toBe(JSON.stringify(plain))
  })
})
