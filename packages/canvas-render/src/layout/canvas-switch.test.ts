import type {
  CommentThread,
  Proposal,
  SpatialCanvas,
  SpatialNode,
} from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import type { CanvasLayoutCore, CanvasLayoutRequest, CoreDegradation } from '../canvas-core.js'
import { highlightCode } from '../highlight/lowlight.js'
import { describeMeasure } from '../measure.js'
import { referenceSeams } from '../references/seams.js'
import { overlayReferences, referenceSeamsFromWire, referenceWire } from '../references/wire.js'
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

type Answering = CanvasLayoutCore['layoutSpatialCanvas']

/** A core answering as `answer` says, keeping each request it was handed. */
function coreOf(impl: CoreImpl, answer: Answering) {
  const requests: CanvasLayoutRequest[] = []
  const highlighters: unknown[] = []
  const mismatches: CoreMismatch[] = []
  const core: LayoutCore = {
    routing: {
      routeLayout: () => {
        throw new Error('the routing core is not asked here')
      },
    },
    layout: {
      layoutSpatialCanvas: (request, highlight) => {
        requests.push(request)
        highlighters.push(highlight)
        return answer(request, highlight)
      },
    },
    impl: { routeLayout: 'ts', layoutSpatialCanvas: impl },
    onMismatch: (mismatch) => mismatches.push(mismatch),
  }
  return { core, requests, highlighters, mismatches }
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

  it('hands the core the default highlighter to tokenise the fences it asks for', () => {
    const { core, highlighters } = coreOf('rust', agreeing)
    layoutSpatialCanvasWithAnchors(canvas, { ...base, core })
    expect(highlighters).toEqual([highlightCode])
  })

  it('answers from the TypeScript what the core declines, reporting its class', () => {
    const { laid, mismatches, requests, events } = run('rust', () => ({ declined: 'body' }))
    expect(requests).toHaveLength(1)
    expect(laid.scene).toEqual(reference.scene)
    expect(mismatches).toEqual([{ fn: 'layoutSpatialCanvas', kind: 'declined', reason: 'body' }])
    expect(events.map((e) => e.kind)).toEqual(['unknown-node-kind'])
  })

  it('reports a layout the request gate skips by its class, asking the core nothing', () => {
    for (const impl of ['rust', 'differential'] as const) {
      const { laid, mismatches, requests } = run(impl, agreeing, { renderMath: () => undefined })
      expect(requests).toEqual([])
      expect(laid.scene).toEqual(reference.scene)
      expect(mismatches).toEqual([
        { fn: 'layoutSpatialCanvas', kind: 'skipped', reason: 'seam:renderMath' },
      ])
    }
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
      ...agreeing(undefined as never, highlightCode),
      anchors: new Map(),
    }))
    expect(anchors.mismatches).toMatchObject([{ kind: 'differs', at: '/anchors/e1' }])
  })
})

const thread: CommentThread = {
  id: 't',
  anchor: { kind: 'text', nodeId: 'a', quote: { exact: 'a', prefix: '' }, start: 0, end: 1 },
  status: 'resolved',
  createdAt: '2026-11-15T00:00:00Z',
  messages: [
    { id: 'm1', body: 'first', author: 'ann', createdAt: '2026-11-15T00:00:00Z' },
    { id: 'm2', body: 'second', editedAt: '2026-11-15T00:00:01Z' },
  ],
}

/** The thread as the core takes it: the author and the timestamps left off. */
const coreThread = {
  id: 't',
  anchor: thread.anchor,
  status: 'resolved',
  messages: [
    { id: 'm1', body: 'first' },
    { id: 'm2', body: 'second' },
  ],
}

const proposal: Proposal = {
  id: 'p',
  author: 'ann',
  createdAt: '2026-11-15T00:00:00Z',
  changes: [
    { id: 'c1', status: 'open', op: 'node.patch', nodeId: 'a', patch: { x: 1 }, assumed: {} },
    {
      id: 'c2',
      status: 'dismissed',
      op: 'body.replace',
      anchor: { kind: 'text', quote: { exact: 'a' }, start: 0, end: 1 },
      text: 'b',
      assumed: 'a',
    },
  ],
}

/** The proposal as the core takes it: no author or timestamp, a passage change by its identity and verdict. */
const coreProposal = {
  id: 'p',
  changes: [
    { id: 'c1', status: 'open', op: 'node.patch', nodeId: 'a', patch: { x: 1 }, assumed: {} },
    { id: 'c2', status: 'dismissed', op: 'body.replace' },
  ],
}

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
      showResolved: true,
      commentObstacles: [{ x: 1, y: 2, w: 3, h: 4 }],
      threads: [thread],
      proposals: [proposal],
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
      threads: [coreThread],
      commentLayer: false,
      showResolved: true,
      commentObstacles: [{ x: 1, y: 2, w: 3, h: 4 }],
      proposals: [coreProposal],
    })
    expect(request({})).toEqual({
      canvas,
      measure: { kind: 'fake', factor: 0.6 },
      mode: 'light',
      expand: false,
    })
  })

  it('names why it cannot hand over a function, a choice the core does not make, or an unnamed value', () => {
    const skipped: [Partial<SpatialLayoutOptions>, string][] = [
      [{ measure: () => ({ advanceWidth: 1, ascent: 1, descent: 0, lineGap: 0 }) }, 'measure'],
      [{ appearance: { ...appearance } }, 'appearance'],
      [{ parseBody: () => ({ type: 'root', children: [] }) }, 'seam:parseBody'],
      [{ renderContributions: [] }, 'seam:renderContributions'],
      [{ renderMath: () => undefined }, 'seam:renderMath'],
      [{ renderDiagram: () => undefined }, 'seam:renderDiagram'],
      [{ resolveEmbed: () => undefined }, 'seam:resolveEmbed'],
      [{ resolveTitle: () => undefined }, 'seam:resolveTitle'],
      [{ resolveAlias: () => null }, 'seam:resolveAlias'],
      [{ resolveReference: () => undefined }, 'seam:resolveReference'],
      [{ nestedLayoutBudget: { remaining: 1 } as never }, 'seam:nestedLayoutBudget'],
      [{ highlightCode: () => undefined }, 'highlighter'],
      [{ references: referenceSeams(new Map()) }, 'references'],
    ]
    for (const [options, reason] of skipped) {
      expect(request(options), reason).toEqual({ skip: reason })
    }
    // A bundled theme built afresh is still the bundled theme, and the
    // default highlighter is no seam.
    const kept = [
      { appearance: createSpatialTheme({ mode: 'light', palette: undefined as never }) },
      { highlightCode },
      { style: 'clean' as const },
      { threads: [thread] },
      { threads: [thread], showResolved: true, commentObstacles: [] },
      { proposals: [proposal] },
      { proposals: [] },
    ]
    for (const options of kept) expect(request(options)).not.toHaveProperty('skip')
  })

  it('carries a drawn style, and the families its themes name that this surface holds', () => {
    for (const style of ['document', 'visual.neon', 'visual.gone']) {
      expect(request({ style })).toEqual({ ...request({}), style })
    }
    expect(request({ style: 'clean', fontAvailable: () => true })).toEqual(request({}))
    const asked: string[] = []
    const held = request({
      style: 'document',
      fontAvailable: (family) => {
        asked.push(family)
        return true
      },
    })
    expect(held).toEqual({ ...request({}), style: 'document', fontFamilies: ['Yomogi'] })
    // Only a family a theme names is asked about, which is all the layout asks.
    expect(asked).toEqual(['Yomogi'])
    expect(request({ style: 'visual.sketch', fontAvailable: () => false })).not.toHaveProperty(
      'fontFamilies',
    )
  })

  it('names the first reason when several hold, the measurer before the rest', () => {
    expect(
      request({
        measure: () => ({ advanceWidth: 1, ascent: 1, descent: 0, lineGap: 0 }),
        style: 'document',
      }),
    ).toEqual({ skip: 'measure' })
    expect(request({ renderMath: () => undefined, style: 'document' })).toEqual({
      skip: 'seam:renderMath',
    })
  })

  it('carries a wire-built reference bundle, unless an extra carries content', () => {
    const wire = {
      entries: [['n', { name: 'Note', body: 'x' }]] as const,
      aliases: [['a', 'n']] as const,
      titles: [['n', 'Note']] as const,
      extras: [['n', { label: 'L', missing: true }]] as const,
    }
    expect(request({ references: referenceSeamsFromWire(wire) })).toMatchObject({
      references: wire,
    })
    for (const extra of [{ canvas }, { markdown: { type: 'root', children: [] } }]) {
      const content = { ...wire, extras: [['n', extra]] as never }
      expect(request({ references: referenceSeamsFromWire(content) })).toEqual({
        skip: 'reference-content',
      })
    }
  })

  it("hands a surface's labels and dangling marks over as extras, where a composed function was skipped", () => {
    const withFiles = {
      ...canvas,
      nodes: [...canvas.nodes, fileNode('fa', 'doc-a'), fileNode('fg', 'doc-gone')],
    }
    const wire = referenceWire(new Map([['doc-a', { name: 'Stored' }]]))
    const chrome = { labels: new Map([['doc-a', 'Alpha']]), missing: new Set(['doc-gone']) }
    const seams = referenceSeamsFromWire(wire)
    const composed = (ref: string) => {
      const label = chrome.labels.get(ref)
      return { ...seams.resolveReference(ref), ...(label === undefined ? {} : { label }) }
    }
    expect(
      canvasLayoutRequest(withFiles, { ...base, references: seams, resolveReference: composed }),
    ).toEqual({ skip: 'seam:resolveReference' })
    const overlaid = overlayReferences(wire, chrome)
    const asked = canvasLayoutRequest(withFiles, {
      ...base,
      references: referenceSeamsFromWire(overlaid),
    })
    expect(asked).toMatchObject({ references: overlaid })
    expect(overlaid.extras).toEqual([
      ['doc-a', { label: 'Alpha' }],
      ['doc-gone', { missing: true }],
    ])
  })

  it('settles the expansion policy over every file node it could be asked', () => {
    const nested: SpatialCanvas = { nodes: [fileNode('f2', 'other')], edges: [] }
    const withFiles = { ...canvas, nodes: [...canvas.nodes, fileNode('f1', 'board')] }
    const wire = {
      entries: [['board', { canvas: nested }]] as const,
      aliases: [],
      titles: [],
      extras: [],
    }
    const references = referenceSeamsFromWire(wire)
    const asked = (policy: (node: SpatialNode) => boolean) => {
      const built = canvasLayoutRequest(withFiles, { ...base, references, expandFileNode: policy })
      return 'skip' in built ? built : built.expand
    }
    const seen: string[] = []
    const noting = (node: SpatialNode) => {
      seen.push(node.id)
      return true
    }
    expect(asked(noting)).toBe(true)
    expect(seen).toEqual(['f1', 'f2'])
    expect(asked(() => false)).toBe(false)
    expect(asked((node) => node.id === 'f1')).toEqual(['f1'])
    expect(asked((node) => node.id === 'f2')).toEqual(['f2'])
  })

  it('skips a policy that answers one id open in one canvas and closed in another', () => {
    const twin = (x: number) => ({ ...fileNode('f', 'board'), x })
    const nested: SpatialCanvas = { nodes: [twin(500), fileNode('g', 'other')], edges: [] }
    const deeper: SpatialCanvas = { nodes: [{ ...fileNode('g', 'other'), x: 900 }], edges: [] }
    const wire = {
      entries: [
        ['board', { canvas: nested }],
        ['other', { canvas: deeper }],
      ] as const,
      aliases: [],
      titles: [],
      extras: [],
    }
    const withFiles = { ...canvas, nodes: [...canvas.nodes, twin(0)] }
    const asked = (policy: (node: SpatialNode) => boolean) => {
      const references = referenceSeamsFromWire(wire)
      const built = canvasLayoutRequest(withFiles, { ...base, references, expandFileNode: policy })
      return 'skip' in built ? built : built.expand
    }
    expect(asked((node) => node.x < 100)).toEqual({ skip: 'expand-collision' })
    expect(asked((node) => node.x > 800)).toEqual({ skip: 'expand-collision' })
    expect(asked((node) => node.id === 'g')).toEqual(['g'])
    expect(asked((node) => node.id === 'f' && node.x < 1000)).toEqual(['f'])
  })

  it('takes a measurer by the name its maker gave it', () => {
    const named = describeMeasure(() => ({ advanceWidth: 1, ascent: 1, descent: 0, lineGap: 0 }), {
      kind: 'ratio',
    })
    expect(request({ measure: named })).toMatchObject({ measure: { kind: 'ratio' } })
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
