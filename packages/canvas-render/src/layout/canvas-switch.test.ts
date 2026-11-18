import type {
  CommentThread,
  Proposal,
  SpatialCanvas,
  SpatialNode,
} from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import type { CanvasLayoutCore, CanvasLayoutRequest } from '../canvas-core.js'
import { highlightCode } from '../highlight/lowlight.js'
import { constantRatioMeasureText, describeMeasure } from '../measure.js'
import { referenceSeams } from '../references/seams.js'
import { overlayReferences, referenceSeamsFromWire, referenceWire } from '../references/wire.js'
import { type LayoutRefusal, refusalScene } from '../refusal.js'
import { fakeLayoutCore } from '../test-utils/fake-layout-core.js'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import { testLayoutCore } from '../test-utils/test-layout-core.js'
import { createSpatialTheme } from '../theme/spatial-theme.js'
import { askedPicture, CoreUnaskable, canvasLayoutRequest } from './canvas-switch.js'
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

const base: SpatialLayoutOptions = { core: testLayoutCore(), measure, appearance }
const reference = layoutSpatialCanvasWithAnchors(canvas, base)

type Answering = CanvasLayoutCore['layoutSpatialCanvas']

/** A core answering as `answer` says, keeping each request it was handed. */
function coreOf(answer: Answering) {
  const requests: CanvasLayoutRequest[] = []
  const highlighters: unknown[] = []
  const measurers: unknown[] = []
  const caches: unknown[] = []
  const core = fakeLayoutCore({
    layout: {
      layoutSpatialCanvas: (request, highlight, measure, cache) => {
        requests.push(request)
        highlighters.push(highlight)
        measurers.push(measure)
        caches.push(cache)
        return answer(request, highlight, measure)
      },
    },
  })
  return { core, requests, highlighters, measurers, caches }
}

const agreeing: Answering = () => ({
  ...reference,
  degradations: [{ kind: 'unknown-node-kind', nodeId: 'u', type: 'x/unknown' }],
})

function run(answer: Answering, options: Partial<SpatialLayoutOptions> = {}) {
  const { core, requests } = coreOf(answer)
  const events: SpatialLayoutDegradation[] = []
  const laid = layoutSpatialCanvasWithAnchors(canvas, {
    ...base,
    ...options,
    core,
    onDegrade: (event) => events.push(event),
  })
  return { laid, requests, events }
}

describe('the whole layout through the core', () => {
  it('answers with the core, its degradations reported as the TypeScript reports them', () => {
    const moved = { ...reference.scene, nodes: reference.scene.nodes.slice(1) }
    const { laid, events, requests } = run(() => ({
      scene: moved,
      anchors: reference.anchors,
      degradations: [
        { kind: 'unknown-node-kind', nodeId: 'u', type: 'x/unknown' },
        { kind: 'body-parse-failed', nodeId: 'a' },
      ],
    }))
    expect(requests).toHaveLength(1)
    expect(laid.scene).toBe(moved)
    expect(events).toEqual([
      { kind: 'unknown-node-kind', nodeId: 'u', type: 'x/unknown' },
      { kind: 'body-parse-failed', nodeId: 'a', err: undefined },
    ])
  })

  it('hands the core the default highlighter to tokenise the fences it asks for', () => {
    const { core, highlighters } = coreOf(agreeing)
    layoutSpatialCanvasWithAnchors(canvas, { ...base, core })
    expect(highlighters).toEqual([highlightCode])
  })

  it('draws what the core refuses as the refusal, and tells onRefused', () => {
    const refused: LayoutRefusal = { code: 'input-too-large', reason: 'too-many-elements' }
    const heard: LayoutRefusal[] = []
    for (const mode of ['light', 'dark'] as const) {
      const { laid, events } = run(() => ({ refused }), {
        appearance: createSpatialTheme({ mode }),
        onRefused: (refusal) => heard.push(refusal),
      })
      expect(laid.scene).toEqual(refusalScene(refused, { measure, mode }))
      expect(laid.anchors.size).toBe(0)
      expect(events).toEqual([])
    }
    expect(heard).toEqual([refused, refused])
  })

  it('draws a refusal the host measurer caused without asking that measurer again', () => {
    const refused: LayoutRefusal = { code: 'malformed', reason: 'host-measure' }
    const failing = describeMeasure(
      () => {
        throw new Error('no canvas context')
      },
      { kind: 'host' },
    )
    const { laid } = run(() => ({ refused }), { measure: failing })
    const drawn = refusalScene(refused, { measure: constantRatioMeasureText, mode: 'light' })
    expect(laid.scene).toEqual(drawn)
  })

  it('draws the refusal where the board is, at the top-left of its boxes', () => {
    const refused: LayoutRefusal = { code: 'input-too-large', reason: 'too-many-elements' }
    const away: SpatialCanvas = {
      nodes: [
        textNode({ id: 'a', x: 900, y: 300, width: 120, height: 60, text: 'a' }),
        textNode({ id: 'b', x: 700, y: 500, width: 120, height: 60, text: 'b' }),
        textNode({ id: 'c', x: 800, y: 100, width: 120, height: 60, text: 'c' }),
        textNode({ id: 'n', x: Number.NaN, y: -1e9, width: 120, height: 60, text: 'n' }),
      ],
      edges: [],
    }
    const { core } = coreOf(() => ({ refused }))
    const laid = layoutSpatialCanvasWithAnchors(away, { ...base, core })
    const at = { x: 700, y: 100 }
    expect(laid.scene).toEqual(refusalScene(refused, { measure, mode: 'light', at }))
    const empty = layoutSpatialCanvasWithAnchors({ nodes: [], edges: [] }, { ...base, core })
    expect(empty.scene).toEqual(refusalScene(refused, { measure, mode: 'light' }))
  })

  it('throws for options no request can carry, asking the core nothing', () => {
    const { core, requests } = coreOf(agreeing)
    expect(() =>
      layoutSpatialCanvasWithAnchors(canvas, { ...base, core, appearance: { ...appearance } }),
    ).toThrow(new CoreUnaskable('appearance'))
    expect(requests).toEqual([])
  })

  it('throws what the core throws: there is no TypeScript to answer in its place', () => {
    const err = new Error('garbled')
    expect(() =>
      run(() => {
        throw err
      }),
    ).toThrow(err)
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

/** The request `options` make of `board`, or the reason `CoreUnaskable` names for why they cannot. */
function askOf(
  board: SpatialCanvas,
  options: Partial<SpatialLayoutOptions>,
): CanvasLayoutRequest | { readonly skip: string } {
  try {
    return canvasLayoutRequest(board, { ...base, ...options })
  } catch (err) {
    if (err instanceof CoreUnaskable) return { skip: err.reason }
    throw err
  }
}

describe('what the core can be handed', () => {
  const request = (options: Partial<SpatialLayoutOptions>) => askOf(canvas, options)

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

  it('names why it cannot hand over an unnamed appearance or a bundle not rebuilt from a wire', () => {
    const skipped: [Partial<SpatialLayoutOptions>, string][] = [
      [{ appearance: { ...appearance } }, 'appearance'],
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

  it('names the first reason when several hold, the appearance before the references', () => {
    expect(
      request({ appearance: { ...appearance }, references: referenceSeams(new Map()) }),
    ).toEqual({ skip: 'appearance' })
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

  it("hands a surface's labels and dangling marks over as extras", () => {
    const withFiles = {
      ...canvas,
      nodes: [...canvas.nodes, fileNode('fa', 'doc-a'), fileNode('fg', 'doc-gone')],
    }
    const wire = referenceWire(new Map([['doc-a', { name: 'Stored' }]]))
    const chrome = { labels: new Map([['doc-a', 'Alpha']]), missing: new Set(['doc-gone']) }
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
      const built = askOf(withFiles, { references, expandFileNode: policy })
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

  it('settles an id answered open in one canvas and closed in another by the outer canvas', () => {
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
      const built = askOf(withFiles, { references, expandFileNode: policy })
      return 'skip' in built ? built : built.expand
    }
    // The board's own `f` and the nested `g` are named first, so their answer stands.
    expect(asked((node) => node.x < 100)).toBe(true)
    expect(asked((node) => node.x > 800)).toBe(false)
    expect(asked((node) => node.id === 'g')).toEqual(['g'])
    expect(asked((node) => node.id === 'f' && node.x < 1000)).toEqual(['f'])
  })

  it('takes a measurer by the name its maker gave it', () => {
    const named = describeMeasure(() => ({ advanceWidth: 1, ascent: 1, descent: 0, lineGap: 0 }), {
      kind: 'ratio',
    })
    expect(request({ measure: named })).toMatchObject({ measure: { kind: 'ratio' } })
  })

  it('names a measurer nobody named as the host: the core asks the function itself', () => {
    const unnamed = () => ({ advanceWidth: 1, ascent: 1, descent: 0, lineGap: 0 })
    expect(request({ measure: unnamed, style: 'document' })).toMatchObject({
      measure: { kind: 'host' },
      style: 'document',
    })
    const { core, requests, measurers } = coreOf(agreeing)
    layoutSpatialCanvasWithAnchors(canvas, { ...base, measure: unnamed, core })
    expect(requests).toMatchObject([{ measure: { kind: 'host' } }])
    expect(measurers).toEqual([unnamed])
  })

  it('hands the core the measurer a host-named request leaves it to ask', () => {
    const host = describeMeasure(() => ({ advanceWidth: 1, ascent: 1, descent: 0, lineGap: 0 }), {
      kind: 'host',
    })
    expect(request({ measure: host })).toMatchObject({ measure: { kind: 'host' } })
    const { core, requests, measurers } = coreOf(agreeing)
    layoutSpatialCanvasWithAnchors(canvas, { ...base, measure: host, core })
    expect(requests).toMatchObject([{ measure: { kind: 'host' } }])
    expect(measurers).toEqual([host])
  })

  it("hands the core the caller's content cache, and none when there is none", () => {
    const { core, requests, caches } = coreOf(agreeing)
    const contentCache = new Map()
    layoutSpatialCanvasWithAnchors(canvas, { ...base, contentCache, core })
    layoutSpatialCanvasWithAnchors(canvas, { ...base, core })
    expect(caches).toEqual([contentCache, undefined])
    expect(caches[0]).toBe(contentCache)
    // The cache is the object itself, never part of the request's data.
    expect(requests[0]).toEqual(requests[1])
  })
})

describe('the picture a layout asked the core for', () => {
  const keyed = { svg: '<svg></svg>', rootOpen: '<svg>', rootAttrs: {}, groups: [] }

  it('is read in the form asked, and an answer in another form is a defect', () => {
    expect(askedPicture({}, { svg: '<svg/>' })).toEqual({ svg: '<svg/>' })
    expect(askedPicture({ form: 'keyed' }, { keyed })).toEqual({ keyed })
    expect(() => askedPicture({}, { keyed })).toThrow('the core answered no SVG')
    expect(() => askedPicture({ form: 'keyed' }, { svg: '<svg/>' })).toThrow(
      'the core answered no SVG',
    )
    expect(() => askedPicture({}, {})).toThrow('the core answered no SVG')
  })
})
