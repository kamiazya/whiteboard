import type { SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import type { CanvasLayoutAnswer, CanvasLayoutRequest, CoreDegradation } from '../canvas-core.js'
import { describeMeasure } from '../measure.js'
import { referenceSeams } from '../references/seams.js'
import { referenceSeamsFromWire } from '../references/wire.js'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import { createSpatialTheme } from '../theme/spatial-theme.js'
import { canvasLayoutRequest, firstDifference } from './canvas-switch.js'
import type { CoreImpl, CoreMismatch, LayoutCore } from './edges/layout-core.js'
import type { SpatialLayoutDegradation, SpatialLayoutOptions } from './layout-options.js'
import { layoutSpatialCanvasWithAnchors } from './spatial-canvas.js'

const measure = createFakeMeasure()
const appearance = createSpatialTheme({ mode: 'light' })

const fileNode = (id: string, file: string): SpatialNode => ({
  id,
  x: 0,
  y: 200,
  width: 200,
  height: 120,
  resource: { mimeType: 'application/octet-stream', location: file },
})

const canvas: SpatialCanvas = {
  nodes: [
    textNode({ id: 'a', x: 0, y: 0, width: 120, height: 60, text: 'a' }),
    textNode({ id: 'b', x: 400, y: 0, width: 120, height: 60, text: 'b' }),
    { id: 'u', x: 0, y: 500, width: 60, height: 60, resource: { mimeType: 'x/unknown' } },
  ],
  edges: [{ id: 'e1', from: { node: 'a' }, to: { node: 'b' } }],
}

const base: SpatialLayoutOptions = { measure, appearance }
const reference = layoutSpatialCanvasWithAnchors(canvas, base)

type Answering = (request: CanvasLayoutRequest) => CanvasLayoutAnswer

/** A core answering as `answer` says, keeping each request it was handed. */
function coreOf(impl: CoreImpl, answer: Answering) {
  const requests: CanvasLayoutRequest[] = []
  const mismatches: CoreMismatch[] = []
  const core: LayoutCore = {
    routing: {
      routeLayout: () => {
        throw new Error('the routing core is not asked here')
      },
    },
    layout: {
      layoutSpatialCanvas: (request) => {
        requests.push(request)
        return answer(request)
      },
    },
    impl: { routeLayout: 'ts', layoutSpatialCanvas: impl },
    onMismatch: (mismatch) => mismatches.push(mismatch),
  }
  return { core, requests, mismatches }
}

const agreeing: Answering = () => ({
  ...reference,
  degradations: [{ kind: 'unknown-node-kind', nodeId: 'u', type: 'x/unknown' }],
})

function run(impl: CoreImpl, answer: Answering, options: Partial<SpatialLayoutOptions> = {}) {
  const { core, requests, mismatches } = coreOf(impl, answer)
  const events: SpatialLayoutDegradation[] = []
  const laid = layoutSpatialCanvasWithAnchors(canvas, {
    ...base,
    ...options,
    core,
    onDegrade: (event) => events.push(event),
  })
  return { laid, requests, mismatches, events }
}

describe('the whole layout through the core switch', () => {
  it('leaves the core unasked under ts, and with no switch at all', () => {
    expect(run('ts', agreeing).requests).toEqual([])
    const { core, requests } = coreOf('rust', agreeing)
    const unswitched: LayoutCore = { ...core, impl: { routeLayout: 'ts' } }
    layoutSpatialCanvasWithAnchors(canvas, { ...base, core: unswitched })
    expect(requests).toEqual([])
  })

  it('answers with the core under rust, its degradations reported as the TypeScript reports them', () => {
    const moved = { ...reference.scene, nodes: reference.scene.nodes.slice(1) }
    const { laid, events, mismatches } = run('rust', () => ({
      scene: moved,
      anchors: reference.anchors,
      degradations: [
        { kind: 'unknown-node-kind', nodeId: 'u', type: 'x/unknown' },
        { kind: 'body-parse-failed', nodeId: 'a' },
      ],
    }))
    expect(laid.scene).toBe(moved)
    expect(events).toEqual([
      { kind: 'unknown-node-kind', nodeId: 'u', type: 'x/unknown' },
      { kind: 'body-parse-failed', nodeId: 'a', err: undefined },
    ])
    expect(mismatches).toEqual([])
  })

  it('answers from the TypeScript what the core declines, unreported', () => {
    const { laid, mismatches, requests, events } = run('rust', () => ({ declined: 'shortcode' }))
    expect(requests).toHaveLength(1)
    expect(laid.scene).toEqual(reference.scene)
    expect(mismatches).toEqual([])
    expect(events.map((e) => e.kind)).toEqual(['unknown-node-kind'])
  })

  it('reports a core that throws and answers from the TypeScript', () => {
    const err = new Error('garbled')
    const { laid, mismatches } = run('differential', () => {
      throw err
    })
    expect(laid.scene).toEqual(reference.scene)
    expect(mismatches).toEqual([
      { fn: 'layoutSpatialCanvas', kind: 'refused', err, repro: expect.anything() },
    ])
  })

  it('compares under differential and answers with the TypeScript', () => {
    const agree = run('differential', agreeing)
    expect(agree.mismatches).toEqual([])
    expect(agree.events.map((e) => e.kind)).toEqual(['unknown-node-kind'])
    const skewed = run('differential', () => ({
      scene: { nodes: [...reference.scene.nodes.slice(0, -1)] },
      anchors: reference.anchors,
      degradations: [{ kind: 'unknown-node-kind', nodeId: 'u', type: 'x/unknown' }],
    }))
    expect(skewed.laid.scene).toEqual(reference.scene)
    const [mismatch] = skewed.mismatches
    expect(mismatch).toMatchObject({ fn: 'layoutSpatialCanvas', kind: 'differs' })
    expect(mismatch?.kind === 'differs' && mismatch.at).toBe(
      `/scene/nodes/${reference.scene.nodes.length - 1}`,
    )
    const events = run('differential', () => ({ ...reference, degradations: [] }))
    expect(events.mismatches).toMatchObject([{ kind: 'differs', at: '/events/0' }])
    const anchors = run('differential', () => ({
      ...agreeing(undefined as never),
      anchors: new Map(),
    }))
    expect(anchors.mismatches).toMatchObject([{ kind: 'differs', at: '/anchors/e1' }])
  })
})

describe('what the core can be handed', () => {
  const request = (options: Partial<SpatialLayoutOptions>) =>
    canvasLayoutRequest(canvas, { ...base, ...options })

  it('names the measurer, the appearance and every data option', () => {
    const overrides = new Map([['e1', { fromSide: 'right', toSide: 'left' } as const]])
    const full = request({
      appearance: createSpatialTheme({ mode: 'dark' }),
      geometry: { paddingPx: 4, labelFontSizePx: 12, minContentWidthPx: 20 },
      lockedNodeIds: ['a'],
      suppressedBodyNodeIds: ['b'],
      edgeSideOverrides: overrides,
      tagLibrary: { k: {} },
      embedPath: ['d'],
      style: 'clean',
      commentLayer: false,
      threads: [{} as never],
    })
    expect(full).toEqual({
      canvas,
      measure: { kind: 'fake', factor: 0.6 },
      mode: 'dark',
      expand: false,
      geometry: { paddingPx: 4, labelFontSizePx: 12, minContentWidthPx: 20 },
      lockedNodeIds: ['a'],
      suppressedBodyNodeIds: ['b'],
      sideOverrides: [['e1', { fromSide: 'right', toSide: 'left' }]],
      tagLibrary: { k: {} },
      embedPath: ['d'],
    })
    expect(request({})).toEqual({
      canvas,
      measure: { kind: 'fake', factor: 0.6 },
      mode: 'light',
      expand: false,
    })
  })

  it('declines what is a function, a choice the core does not make, or an unnamed value', () => {
    const declined: Partial<SpatialLayoutOptions>[] = [
      { measure: () => ({ advanceWidth: 1, ascent: 1, descent: 0, lineGap: 0 }) },
      { appearance: createSpatialTheme({ mode: 'light', palette: undefined as never }) },
      { appearance: { ...appearance } },
      { parseBody: () => ({ type: 'root', children: [] }) },
      { renderContributions: [] },
      { renderMath: () => undefined },
      { renderDiagram: () => undefined },
      { resolveEmbed: () => undefined },
      { resolveTitle: () => undefined },
      { resolveAlias: () => null },
      { resolveReference: () => undefined },
      { nestedLayoutBudget: { remaining: 1 } as never },
      { highlightCode: () => undefined },
      { style: 'document' },
      { threads: [{} as never] },
      { proposals: [{} as never] },
      { references: referenceSeams(new Map()) },
    ]
    const kept = declined.filter((options) => request(options) !== undefined)
    // A bundled theme built afresh is still the bundled theme.
    expect(kept).toEqual([declined[1]])
  })

  it('carries a wire-built reference bundle, unless an extra carries content', () => {
    const wire = {
      entries: [['n', { name: 'Note', body: 'x' }]] as const,
      aliases: [['a', 'n']] as const,
      titles: [['n', 'Note']] as const,
      extras: [['n', { label: 'L', missing: true }]] as const,
    }
    expect(request({ references: referenceSeamsFromWire(wire) })?.references).toEqual(wire)
    for (const extra of [{ canvas }, { markdown: { type: 'root', children: [] } }]) {
      const content = { ...wire, extras: [['n', extra]] as never }
      expect(request({ references: referenceSeamsFromWire(content) })).toBeUndefined()
    }
  })

  it('settles the expansion policy over every file node it could be asked, or declines', () => {
    const nested: SpatialCanvas = { nodes: [fileNode('f2', 'other')], edges: [] }
    const withFiles = { ...canvas, nodes: [...canvas.nodes, fileNode('f1', 'board')] }
    const wire = {
      entries: [['board', { canvas: nested }]] as const,
      aliases: [],
      titles: [],
      extras: [],
    }
    const references = referenceSeamsFromWire(wire)
    const asked = (policy: (node: SpatialNode) => boolean) =>
      canvasLayoutRequest(withFiles, { ...base, references, expandFileNode: policy })?.expand
    const seen: string[] = []
    expect(asked((node) => (seen.push(node.id), true))).toBe(true)
    expect(seen).toEqual(['f1', 'f2'])
    expect(asked(() => false)).toBe(false)
    expect(asked((node) => node.id === 'f1')).toBeUndefined()
  })

  it('takes a measurer by the name its maker gave it', () => {
    const named = describeMeasure(() => ({ advanceWidth: 1, ascent: 1, descent: 0, lineGap: 0 }), {
      kind: 'ratio',
    })
    expect(request({ measure: named })?.measure).toEqual({ kind: 'ratio' })
  })
})

describe('firstDifference', () => {
  it('names the path to the first value two answers part at', () => {
    expect(firstDifference({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBeUndefined()
    expect(firstDifference({ a: [1, { b: 2 }] }, { a: [1, { b: 3 }] })).toBe('/a/1/b')
    expect(firstDifference({ a: 1, b: undefined }, { a: 1 })).toBeUndefined()
    expect(firstDifference({ a: 1 }, { a: 1, c: 0 })).toBe('/c')
    expect(firstDifference([0], [-0])).toBe('/0')
    expect(firstDifference([Number.NaN], [Number.NaN])).toBeUndefined()
    expect(firstDifference([1], { 0: 1 })).toBe('')
    expect(firstDifference(null, {})).toBe('')
    expect(firstDifference([1, 2], [1])).toBe('/1')
  })
})

const _typed: CoreDegradation = { kind: 'font-missing', family: 'x' }
void _typed
