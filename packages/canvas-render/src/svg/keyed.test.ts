import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import type { MdastRoot } from '@kamiazya/whiteboard-model/mdast'
import { describe, expect, it } from 'vitest'
import type { SpatialAppearanceResolver } from '../layout/nodes/spatial-appearance.js'
import { layoutSpatialCanvas } from '../layout/spatial-canvas.js'
import { sceneEntryKeys } from '../scene-entry-keys.js'
import type { Scene } from '../scene-graph.js'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import { renderSceneToSvg } from './backend.js'
import { renderSceneToKeyedSvg } from './keyed.js'

const scene: Scene = {
  nodes: [
    { kind: 'shape', id: 'node-a', bbox: { x: 0, y: 0, w: 100, h: 60 }, radius: 4 },
    {
      kind: 'paragraph',
      bbox: { x: 8, y: 8, w: 80, h: 16 },
      runs: [
        {
          kind: 'textRun',
          bbox: { x: 8, y: 8, w: 40, h: 16 },
          text: 'hello',
          truncated: true,
        },
      ],
    },
    { kind: 'shape', id: 'node-b', bbox: { x: 200, y: 0, w: 100, h: 60 } },
    {
      kind: 'edge',
      id: 'edge-1',
      path: [
        { x: 100, y: 30 },
        { x: 200, y: 30 },
      ],
      fromSide: 'right',
      toSide: 'left',
      fromEnd: 'none',
      toEnd: 'arrow',
      appearance: { stroke: '#888' },
    },
  ],
}

describe('sceneEntryKeys', () => {
  it('keys identified entries by id and content entries by owner and ordinal', () => {
    expect(sceneEntryKeys(scene)).toEqual(['node-a', 'node-a#1', 'node-b', 'edge-1'])
  })

  it('keys leading unidentified entries under the preamble owner', () => {
    const bare: Scene = {
      nodes: [
        { kind: 'paragraph', bbox: { x: 0, y: 0, w: 10, h: 10 }, runs: [] },
        { kind: 'shape', id: 's', bbox: { x: 0, y: 0, w: 1, h: 1 } },
      ],
    }
    expect(sceneEntryKeys(bare)).toEqual(['preamble#1', 's'])
  })
})

describe('renderSceneToKeyedSvg', () => {
  it('emits one keyed group per scene entry, plus the defs pseudo-group', () => {
    const keyed = renderSceneToKeyedSvg(scene)
    expect(keyed.groups.map((g) => g.key)).toEqual([
      '#defs',
      'node-a',
      'node-a#1',
      'node-b',
      'edge-1',
    ])
    for (const group of keyed.groups) {
      if (group.key.startsWith('#')) continue
      expect(group.svg.startsWith(`<g data-wb-key="${group.key}">`)).toBe(true)
      expect(group.svg.endsWith('</g>')).toBe(true)
    }
  })

  it('assembles the document exactly from its parts', () => {
    const keyed = renderSceneToKeyedSvg(scene, { padding: 4, background: '#fff' })
    const body = keyed.groups.map((g) => g.svg).join('')
    expect(keyed.svg).toBe(`${keyed.rootOpen}${body}</svg>`)
    expect(keyed.groups.map((g) => g.key).slice(0, 2)).toEqual(['#defs', '#background'])
  })

  it('carries the root attributes the patch layer must keep in sync', () => {
    const keyed = renderSceneToKeyedSvg(scene, { padding: 4 })
    expect(keyed.rootAttrs.xmlns).toBe('http://www.w3.org/2000/svg')
    expect(typeof keyed.rootAttrs.viewBox).toBe('string')
  })

  it('is byte-identical to renderSceneToSvg once the key wrappers are removed', () => {
    for (const options of [undefined, { padding: 4, background: '#fff' }] as const) {
      const keyed = renderSceneToKeyedSvg(scene, options)
      // Exact reconstruction, no regex: a non-pseudo group is by contract
      // `<g data-wb-key="KEY">` + inner + `</g>`; pseudo groups (#defs,
      // #background) are emitted unwrapped in both forms.
      const unwrapped = keyed.groups
        .map((group) =>
          group.key.startsWith('#')
            ? group.svg
            : group.svg.slice(`<g data-wb-key="${group.key}">`.length, -'</g>'.length),
        )
        .join('')
      expect(`${keyed.rootOpen}${unwrapped}</svg>`).toBe(renderSceneToSvg(scene, options))
    }
  })

  it('changes exactly the groups whose scene entries changed', () => {
    const before = renderSceneToKeyedSvg(scene)
    const movedB: Scene = {
      nodes: scene.nodes.map((n) =>
        'id' in n && n.id === 'node-b' && n.kind === 'shape'
          ? { ...n, bbox: { ...n.bbox, x: 220 } }
          : n,
      ),
    }
    const after = renderSceneToKeyedSvg(movedB)
    const beforeByKey = new Map(before.groups.map((g) => [g.key, g.svg]))
    const changed = after.groups.filter((g) => beforeByKey.get(g.key) !== g.svg).map((g) => g.key)
    expect(changed).toEqual(['node-b'])
  })
})

describe('renderSceneToKeyedSvg over a comment scene', () => {
  it('keys the pin and bubble by the editor hit-testing handle, not a leader ordinal', () => {
    const appearance: SpatialAppearanceResolver = {
      resolveNode: () => ({}),
      resolveEdge: () => ({}),
      resolveLabel: () => ({ fill: '#000', fontFamily: 'sans-serif' }),
    }
    const parseBody = (text: string): MdastRoot => ({
      type: 'root',
      children: [{ type: 'paragraph', children: [{ type: 'text', value: text }] }],
    })
    const canvas: SpatialCanvas = {
      nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 100, height: 60, text: 'n1' }],
      edges: [],
      'x-whiteboard': { comments: [{ id: 'c1', x: 400, y: 60, text: 'move this left' }] },
    }
    const laidOut = layoutSpatialCanvas(canvas, {
      measure: createFakeMeasure(),
      parseBody,
      appearance,
      geometry: { paddingPx: 8, labelFontSizePx: 12, minContentWidthPx: 1 },
    })

    const keys = renderSceneToKeyedSvg(laidOut).groups.map((g) => g.key)
    expect(keys).toContain('c1/pin')
    expect(keys).toContain('c1/bubble')
    // The comment's text runs follow the bubble in document order, so they
    // rebase onto its ordinal rather than the old c1/leader#N spelling.
    expect(keys.some((key) => key.startsWith('c1/bubble#'))).toBe(true)
  })
})

/**
 * The annotation layer appears and disappears as a UNIT, and a consumer
 * that patches the DOM has to know which groups those are.
 *
 * Resolving a conversation is not a recolour on this surface: with the
 * default `showResolved`, the pin, its count, the leader and the whole
 * bubble leave the scene together, and with the toggle on all four change
 * paint at once. Either way a patch layer wants to treat them as one thing
 * — and it must not reach that conclusion from the key's SHAPE, because a
 * stored comment id may contain a `/` exactly like a document node id can
 * (the same trap `ShapeSceneNode.commentChrome` exists to avoid in
 * `sceneDigest`).
 *
 * Content entries inherit it from their owner, which is what carries the
 * count run sitting on the pin and the body sitting in the bubble — neither
 * has an id of its own to be marked by.
 */
describe('the keyed projection marks the annotation layer', () => {
  const appearance: SpatialAppearanceResolver = {
    resolveNode: () => ({}),
    resolveEdge: () => ({}),
    resolveLabel: () => ({ fill: '#000', fontFamily: 'sans-serif' }),
    resolveComment: () => ({
      pin: { fill: '#d97706' },
      bubble: { fill: '#fef3c7', stroke: '#d97706' },
      leader: { stroke: '#d97706' },
      passage: { fill: '#d97706', fillOpacity: 0.22 },
      region: { fill: 'none', stroke: '#d97706' },
      pinCount: { fill: '#fef3c7', fontFamily: 'sans-serif' },
      resolvedOverlay: {
        pin: { fill: '#d97706', fillOpacity: 0.45 },
        bubble: { fill: '#fef3c7', stroke: '#d97706', fillOpacity: 0.45 },
        leader: { stroke: '#d97706', strokeOpacity: 0.45 },
        passage: { fill: '#d97706', fillOpacity: 0.1 },
        region: { fill: 'none', stroke: '#d97706', strokeOpacity: 0.45 },
        pinCount: { fill: '#fef3c7', fontFamily: 'sans-serif', fillOpacity: 0.45 },
      },
    }),
  }
  const parseBody = (text: string): MdastRoot => ({
    type: 'root',
    children: [{ type: 'paragraph', children: [{ type: 'text', value: text }] }],
  })
  const canvas: SpatialCanvas = {
    nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 100, height: 60, text: 'n1' }],
    edges: [],
    'x-whiteboard': { comments: [{ id: 'c1', x: 400, y: 60, text: 'move this left' }] },
  }
  const laidOut = layoutSpatialCanvas(canvas, {
    measure: createFakeMeasure(),
    parseBody,
    appearance,
    // Two messages, so the pin carries a count — the entry with no id of
    // its own, which is the case owner inheritance exists for.
    threads: [
      {
        id: 'c1',
        anchor: { kind: 'spatial', x: 400, y: 60 },
        status: 'open',
        messages: [
          { id: 'm1', body: 'move this left' },
          { id: 'm2', body: 'agreed' },
        ],
      },
    ],
    geometry: { paddingPx: 8, labelFontSizePx: 12, minContentWidthPx: 1 },
  })

  it('marks every group the conversation draws, including the ones with no id of their own', () => {
    const marked = renderSceneToKeyedSvg(laidOut)
      .groups.filter((group) => group.annotation === true)
      .map((group) => group.key)
      .sort()

    // The whole set, by equality: a subset check would pass while the
    // leader still cut on its own.
    expect(marked).toEqual(['c1/bubble', 'c1/bubble#1', 'c1/leader', 'c1/pin', 'c1/pin#1'])
  })

  it('leaves the document nodes and the chrome pseudo-groups unmarked', () => {
    const groups = renderSceneToKeyedSvg(laidOut, { padding: 4, background: '#fff' }).groups
    const unmarked = groups.filter((group) => group.annotation !== true).map((group) => group.key)
    // No `#defs`: this scene draws nothing that needs one, and the
    // pseudo-group is emitted only when it is non-empty.
    expect(unmarked).toEqual(['#background', 'n1', 'n1#1'])
  })

  it('leaves the emitted bytes untouched — the mark is out-of-band', () => {
    // The projection's whole safety argument is that its bytes are
    // `renderSceneToSvg`'s. A marker that reached the document would break
    // that, and would also be a second place the annotation layer is
    // spelled.
    const keyed = renderSceneToKeyedSvg(laidOut, { padding: 4 })
    expect(keyed.svg).not.toContain('annotation')
    const unwrapped = keyed.groups
      .map((group) =>
        group.key.startsWith('#')
          ? group.svg
          : group.svg.slice(`<g data-wb-key="${group.key}">`.length, -'</g>'.length),
      )
      .join('')
    expect(`${keyed.rootOpen}${unwrapped}</svg>`).toBe(renderSceneToSvg(laidOut, { padding: 4 }))
  })
})
