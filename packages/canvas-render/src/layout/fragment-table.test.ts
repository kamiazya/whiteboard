import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import type { CanvasLayoutRequest } from '../canvas-core.js'
import { type FragmentAsk, type FragmentEntry, fragmentAskKey } from '../fragment-ask.js'
import { fakeLayoutCore } from '../test-utils/fake-layout-core.js'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import { createSpatialTheme } from '../theme/spatial-theme.js'
import { CoreUnaskable, canvasLayoutRequest } from './canvas-switch.js'
import type { SpatialLayoutOptions } from './layout-options.js'
import { layoutSpatialCanvasWithAnchors, naturalNodeContentSize } from './spatial-canvas.js'

const base: SpatialLayoutOptions = {
  measure: createFakeMeasure(),
  appearance: createSpatialTheme({ mode: 'light' }),
}

const BODY = ['$$\nx^2\n$$', '```mermaid\ngraph TD\n```', '$$\ny\n$$', '$$\nx^2\n$$'].join('\n\n')

const canvas: SpatialCanvas = {
  nodes: [textNode({ id: 'm', x: 0, y: 0, width: 300, height: 400, text: BODY })],
  edges: [],
}

const X2: FragmentEntry = ['math:x^2', { svg: '<g data-x2/>', width: 40, height: 20 }]

/** The svg fragments a scene draws, in order. */
const drawn = (options: SpatialLayoutOptions): string[] =>
  layoutSpatialCanvasWithAnchors(canvas, options).scene.nodes.flatMap(
    function svgs(node): string[] {
      const own = node.kind === 'svgFragment' ? [node.svg] : []
      const children = 'children' in node && Array.isArray(node.children) ? node.children : []
      return [...own, ...children.flatMap(svgs)]
    },
  )

function asked(options: Partial<SpatialLayoutOptions>): FragmentAsk[][] {
  const calls: FragmentAsk[][] = []
  layoutSpatialCanvasWithAnchors(canvas, {
    ...base,
    ...options,
    onFragmentsAsked: (asks) => calls.push([...asks]),
  })
  return calls
}

describe('rendered fragments as a table', () => {
  it('keys a math block and a fence apart', () => {
    expect(fragmentAskKey({ kind: 'math', value: 'x' })).toBe('math:x')
    expect(fragmentAskKey({ kind: 'diagram', lang: 'math', value: 'x' })).toBe('fence:math:x')
  })

  it('draws what the table holds and reports the rest once each, in the order met', () => {
    expect(drawn({ ...base, fragments: [X2] })).toContain('<g data-x2/>')
    expect(asked({ fragments: [X2] })).toEqual([
      [
        { kind: 'diagram', lang: 'mermaid', value: 'graph TD' },
        { kind: 'math', value: 'y' },
      ],
    ])
    expect(asked({ fragments: [] })[0]?.[0]).toEqual({ kind: 'math', value: 'x^2' })
    expect(asked({})).toEqual([
      [{ kind: 'math', value: 'x^2' }, ...(asked({ fragments: [X2] })[0] ?? [])],
    ])
  })

  it('answers with the later of two rows, and reports nothing when nothing is missing', () => {
    const later: FragmentEntry = ['math:x^2', { svg: '<g data-later/>' }]
    expect(drawn({ ...base, fragments: [X2, later] })).toContain('<g data-later/>')
    const all: FragmentEntry[] = [
      X2,
      ['math:y', { svg: '<g/>' }],
      ['fence:mermaid:graph TD', { svg: '<g/>', width: 10, height: 10 }],
    ]
    expect(asked({ fragments: all })).toEqual([])
  })

  it('keeps no body that read the table, so a later table is drawn and asked again', () => {
    const contentCache = new Map()
    expect(drawn({ ...base, fragments: [], contentCache })).not.toContain('<g data-x2/>')
    expect(drawn({ ...base, fragments: [X2], contentCache })).toContain('<g data-x2/>')
    expect(asked({ fragments: [], contentCache })[0]?.[0]).toEqual({ kind: 'math', value: 'x^2' })
    expect(drawn({ ...base, fragments: [], contentCache })).not.toContain('<g data-x2/>')
    // A body that never reads it is still kept.
    const plain = new Map()
    layoutSpatialCanvasWithAnchors(
      {
        nodes: [textNode({ id: 'p', x: 0, y: 0, width: 200, height: 80, text: 'words' })],
        edges: [],
      },
      { ...base, fragments: [X2], contentCache: plain },
    )
    expect(plain.size).toBe(1)
  })

  it('keys a body laid out beside a table as the core keys it', () => {
    // The same literals the core's key is pinned to, in
    // `crates/core/canvas-render/tests/compose_canvas_fragment_cache.rs`.
    const board: SpatialCanvas = {
      nodes: [textNode({ id: 'a', x: 0, y: 0, width: 260, height: 200, text: 'plain' })],
      edges: [],
    }
    const without = new Map()
    layoutSpatialCanvasWithAnchors(board, { ...base, contentCache: without })
    const beside = new Map()
    layoutSpatialCanvasWithAnchors(board, { ...base, fragments: [], contentCache: beside })
    expect([...without.keys()]).toEqual(['[260,200,"plain",null,"Roboto",null,[]]'])
    expect([...beside.keys()]).toEqual(['[260,200,"plain",null,"Roboto",null,[],"fragments"]'])
  })

  it('serves no body cached without a table to a layout with one', () => {
    const contentCache = new Map()
    expect(drawn({ ...base, contentCache })).not.toContain('<g data-x2/>')
    expect(asked({ fragments: [], contentCache })[0]?.[0]).toEqual({ kind: 'math', value: 'x^2' })
    expect(drawn({ ...base, fragments: [X2], contentCache })).toContain('<g data-x2/>')
    // Nor one a caller's own function drew, with or without a table beside
    // it, on a board whose only seam is the one that function answers.
    const fn = () => ({ svg: '<g data-fn/>' })
    const kinds = [
      ['$$\nx^2\n$$', { renderMath: fn }, X2],
      ['```mermaid\ng\n```', { renderDiagram: fn }, ['fence:mermaid:g', { svg: '<g data-x2/>' }]],
    ] as const
    for (const [text, seam, row] of kinds) {
      const board: SpatialCanvas = {
        nodes: [textNode({ id: 'x', x: 0, y: 0, width: 300, height: 200, text })],
        edges: [],
      }
      const svgs = (options: SpatialLayoutOptions) =>
        JSON.stringify(layoutSpatialCanvasWithAnchors(board, options).scene)
      for (const first of [{}, { fragments: [] }] as const) {
        const cache = new Map()
        expect(svgs({ ...base, ...first, ...seam, contentCache: cache })).toContain('data-fn')
        const later = svgs({ ...base, fragments: [row], contentCache: cache })
        expect(later, `${text} ${JSON.stringify(first)}`).toContain('data-x2')
      }
    }
  })

  it('sizes a node by the fragment the table holds, as its layout draws it', () => {
    const node = textNode({ id: 'n', x: 0, y: 0, width: 300, height: 40, text: '$$\nx^2\n$$' })
    const tall: FragmentEntry = ['math:x^2', { svg: '<g/>', width: 250, height: 120 }]
    const sized = naturalNodeContentSize(node, { ...base, fragments: [tall] })
    expect(sized.h).toBeGreaterThanOrEqual(120)
    expect(sized.h).toBeGreaterThan(naturalNodeContentSize(node, { ...base, fragments: [] }).h)
  })

  it('leaves a function seam in charge of its kind', () => {
    const calls = asked({ fragments: [], renderMath: () => ({ svg: '<g data-fn/>' }) })
    expect(calls).toEqual([[{ kind: 'diagram', lang: 'mermaid', value: 'graph TD' }]])
  })
})

/** A core answering with the TypeScript's own layout and `asks`. */
function coreOf(asks: readonly FragmentAsk[] | undefined) {
  const requests: CanvasLayoutRequest[] = []
  const core = fakeLayoutCore({
    layout: {
      layoutSpatialCanvas: (request) => {
        requests.push(request)
        const laid = layoutSpatialCanvasWithAnchors(canvas, { ...base, fragments: [X2] })
        return { ...laid, degradations: [], ...(asks && { fragmentsAsked: asks }) }
      },
    },
  })
  return { core, requests }
}

describe('the request and the core, with a table', () => {
  const request = (options: Partial<SpatialLayoutOptions>) =>
    canvasLayoutRequest(canvas, { ...base, ...options })

  it('carries the table, an empty one for a caller that only listens, and none otherwise', () => {
    expect(request({ fragments: [X2] })).toMatchObject({ fragments: [X2] })
    expect(request({ onFragmentsAsked: () => {} })).toMatchObject({ fragments: [] })
    expect(request({})).not.toHaveProperty('fragments')
    expect(() => request({ fragments: [X2], renderMath: () => undefined })).toThrow(
      new CoreUnaskable('seam:renderMath'),
    )
  })

  const theirs: FragmentAsk[] = [
    { kind: 'diagram', lang: 'mermaid', value: 'graph TD' },
    { kind: 'math', value: 'y' },
  ]

  it("hands the core's asks to the caller, and none when it reports none", () => {
    const { core } = coreOf(theirs)
    expect(asked({ fragments: [X2], core })).toEqual([theirs])
    expect(asked({ fragments: [X2], core: coreOf([]).core })).toEqual([])
    expect(asked({ fragments: [X2], core: coreOf(undefined).core })).toEqual([])
  })
})
