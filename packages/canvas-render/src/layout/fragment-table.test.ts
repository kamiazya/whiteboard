import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import type { CanvasLayoutRequest } from '../canvas-core.js'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import { createSpatialTheme } from '../theme/spatial-theme.js'
import { canvasLayoutRequest } from './canvas-switch.js'
import type { CoreImpl, CoreMismatch, LayoutCore } from './edges/layout-core.js'
import type { SpatialLayoutOptions } from './layout-options.js'
import { type FragmentAsk, type FragmentEntry, fragmentAskKey } from './nodes/fragment-ask.js'
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
function coreOf(impl: CoreImpl, asks: readonly FragmentAsk[] | undefined) {
  const requests: CanvasLayoutRequest[] = []
  const mismatches: CoreMismatch[] = []
  const core: LayoutCore = {
    routing: { routeLayout: () => ({ routes: [], anchors: new Map() }) as never },
    layout: {
      layoutSpatialCanvas: (request) => {
        requests.push(request)
        const laid = layoutSpatialCanvasWithAnchors(canvas, { ...base, fragments: [X2] })
        return { ...laid, degradations: [], ...(asks && { fragmentsAsked: asks }) }
      },
    },
    impl: { routeLayout: 'ts', layoutSpatialCanvas: impl },
    onMismatch: (mismatch) => mismatches.push(mismatch),
  }
  return { core, requests, mismatches }
}

describe('the request gate and the core, with a table', () => {
  const request = (options: Partial<SpatialLayoutOptions>) =>
    canvasLayoutRequest(canvas, { ...base, ...options })

  it('carries the table, an empty one for a caller that only listens, and none otherwise', () => {
    expect(request({ fragments: [X2] })).toMatchObject({ fragments: [X2] })
    expect(request({ onFragmentsAsked: () => {} })).toMatchObject({ fragments: [] })
    expect(request({})).not.toHaveProperty('fragments')
    expect(request({ fragments: [X2], renderMath: () => undefined })).toEqual({
      skip: 'seam:renderMath',
    })
  })

  const theirs: FragmentAsk[] = [
    { kind: 'diagram', lang: 'mermaid', value: 'graph TD' },
    { kind: 'math', value: 'y' },
  ]

  it("hands the core's asks to the caller under rust, and none when it reports none", () => {
    const { core } = coreOf('rust', theirs)
    expect(asked({ fragments: [X2], core })).toEqual([theirs])
    expect(asked({ fragments: [X2], core: coreOf('rust', []).core })).toEqual([])
    expect(asked({ fragments: [X2], core: coreOf('rust', undefined).core })).toEqual([])
  })

  it('compares the asks under differential, a content cache beside them or not', () => {
    const agreeing = coreOf('differential', theirs)
    expect(asked({ fragments: [X2], core: agreeing.core })).toEqual([theirs])
    expect(agreeing.mismatches).toEqual([])
    const parting = coreOf('differential', theirs.slice(1))
    asked({ fragments: [X2], core: parting.core })
    expect(parting.mismatches).toMatchObject([{ kind: 'differs', at: '/fragmentsAsked/0/kind' }])
    const unheard = coreOf('differential', theirs)
    layoutSpatialCanvasWithAnchors(canvas, { ...base, fragments: [X2], core: unheard.core })
    expect(unheard.mismatches, 'a table with no listener').toEqual([])
    // Warm first: a cached body would answer the second layout without asking.
    const contentCache = new Map()
    asked({ fragments: [X2], contentCache })
    const cached = coreOf('differential', theirs)
    expect(asked({ fragments: [X2], core: cached.core, contentCache })).toEqual([theirs])
    expect(cached.mismatches).toEqual([])
  })
})
