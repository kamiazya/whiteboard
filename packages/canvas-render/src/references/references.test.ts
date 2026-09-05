import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import type { LoadedReference, ReferenceGraph } from './loaded-reference.js'
import { overlayReferences, referenceSeams } from './seams.js'
import { REFERENCE_BUDGET, referenceTargets } from './targets.js'
import { referenceSeamsFromWire, referenceWire } from './wire.js'

const NOTE_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const BOARD_ID = '01BX5ZZKBKACTAV9WEVGEMMVRZ'

const board: SpatialCanvas = {
  nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 200, height: 100, text: 'on the board' }],
  edges: [],
}

function graphOf(entries: Record<string, LoadedReference | null>): ReferenceGraph {
  return new Map(Object.entries(entries))
}

describe('referenceTargets', () => {
  it("names a body's links and embeds, a canvas's file nodes, and what loaded bodies name", () => {
    const canvas: SpatialCanvas = {
      nodes: [
        { id: 'f', type: 'file', x: 0, y: 0, width: 10, height: 10, file: 'boards/roadmap' },
        { id: 'i', type: 'file', x: 0, y: 0, width: 10, height: 10, file: 'asset:abc' },
      ],
      edges: [],
    }
    const targets = referenceTargets({
      bodies: ['see [[notes/plan#Launch]] and ![[boards/roadmap]]'],
      canvases: [canvas],
      loaded: graphOf({ 'notes/plan': { documentId: NOTE_ID, body: '![[deeper]]' } }),
    })
    expect(targets).toEqual(['notes/plan', 'boards/roadmap', 'deeper'])
  })

  it('walks a loaded canvas as well as a loaded body, so a nested file node loads', () => {
    // Root canvas -> spatial A -> file node B: B is drawn inside A's
    // miniature, so it has to be one fetch away like a body's embed is.
    const nested: SpatialCanvas = {
      nodes: [{ id: 'f', type: 'file', x: 0, y: 0, width: 10, height: 10, file: 'boards/b' }],
      edges: [],
    }
    const targets = referenceTargets({
      bodies: ['![[boards/a]]'],
      loaded: graphOf({ 'boards/a': { documentId: BOARD_ID, canvas: nested } }),
    })
    expect(targets).toEqual(['boards/a', 'boards/b'])
  })

  it("names what a canvas's text nodes embed and link, as a seed and once loaded", () => {
    // A text node's body is markdown like any note's, and the composer lays
    // it out with the same seams — so what it points at has to load too.
    const withText: SpatialCanvas = {
      nodes: [
        { id: 't', type: 'text', x: 0, y: 0, width: 10, height: 10, text: 'see ![[notes/a]]' },
      ],
      edges: [],
    }
    expect(referenceTargets({ canvases: [withText] })).toEqual(['notes/a'])
    const targets = referenceTargets({
      bodies: ['![[boards/b]]'],
      loaded: graphOf({ 'boards/b': { documentId: BOARD_ID, canvas: withText } }),
    })
    expect(targets).toEqual(['boards/b', 'notes/a'])
  })

  it("stops at the layout's embed depth, so a link graph is never loaded whole", () => {
    // Root -> d1 -> d2 -> d3 -> d4: d3 is the last level the layout draws,
    // so what d3 names is never asked for, however much has loaded.
    const loaded = graphOf({
      d1: { body: '![[d2]]' },
      d2: { body: '![[d3]]' },
      d3: { body: '![[d4]]' },
      d4: { body: '![[d5]]' },
    })
    expect(referenceTargets({ bodies: ['![[d1]]'], loaded })).toEqual(['d1', 'd2', 'd3'])
  })

  it('caps the total at a budget, and says so in order of discovery', () => {
    const body = Array.from({ length: 300 }, (_, i) => `[[n${i}]]`).join(' ')
    const targets = referenceTargets({ bodies: [body] })
    expect(targets).toHaveLength(REFERENCE_BUDGET)
    expect(targets[0]).toBe('n0')
  })
})

describe('referenceSeams', () => {
  const graph = graphOf({
    'notes/plan': {
      documentId: NOTE_ID,
      name: 'The Plan',
      body: '## Launch\n\nbody [[boards/roadmap]]',
    },
    'boards/roadmap': { documentId: BOARD_ID, name: 'Roadmap', canvas: board },
    missing: null,
  })

  it('resolves an alias through the graph, and through the caller table first', () => {
    const seams = referenceSeams(graph, {
      resolveAlias: (alias) => (alias === 'fast' ? 'X' : null),
    })
    expect(seams.resolveAlias('notes/plan')).toBe(NOTE_ID)
    expect(seams.resolveAlias('fast')).toBe('X')
    expect(seams.resolveAlias('missing')).toBeNull()
    expect(seams.resolveAlias('never-seen')).toBeNull()
  })

  it('titles by id from the graph, then from the caller table', () => {
    const seams = referenceSeams(graph, {
      resolveTitle: (id) => (id === 'Y' ? 'Elsewhere' : undefined),
    })
    expect(seams.resolveTitle(NOTE_ID)).toBe('The Plan')
    expect(seams.resolveTitle('Y')).toBe('Elsewhere')
    expect(seams.resolveTitle('Z')).toBeUndefined()
  })

  it('embeds a markdown record as its parsed body, references inside resolved by the same seams', () => {
    const seams = referenceSeams(graph)
    const embedded = seams.resolveEmbed(NOTE_ID)
    if (embedded === undefined || !('root' in embedded)) throw new Error('expected a body')
    expect(embedded.title).toBe('The Plan')
    expect(JSON.stringify(embedded.root)).toContain(`"documentId":"${BOARD_ID}"`)
  })

  it('embeds a spatial record as its canvas, empty or not', () => {
    const seams = referenceSeams(graph)
    expect(seams.resolveEmbed(BOARD_ID)).toEqual({ title: 'Roadmap', canvas: board })
    const empty = referenceSeams(
      graphOf({ e: { documentId: 'E', canvas: { nodes: [], edges: [] } } }),
    )
    expect(empty.resolveEmbed('E')).toEqual({ canvas: { nodes: [], edges: [] } })
  })

  it('a record with a body is markdown even when it also carries a canvas', () => {
    const seams = referenceSeams(
      graphOf({ legacy: { documentId: 'L', body: 'prose', canvas: board } }),
    )
    expect('root' in (seams.resolveEmbed('L') ?? {})).toBe(true)
    expect(seams.resolveReference('legacy')?.canvas).toBeUndefined()
    expect(seams.resolveReference('legacy')?.markdown).toBeDefined()
  })

  it('a file reference draws label + canvas, or label + prose, and an empty canvas as the card', () => {
    const seams = referenceSeams(graph)
    expect(seams.resolveReference('boards/roadmap')).toEqual({ label: 'Roadmap', canvas: board })
    expect(seams.resolveReference('notes/plan')?.label).toBe('The Plan')
    expect(seams.resolveReference('notes/plan')?.markdown).toBeDefined()
    const empty = referenceSeams(
      graphOf({ e: { name: 'Empty', canvas: { nodes: [], edges: [] } } }),
    )
    expect(empty.resolveReference('e')).toEqual({ label: 'Empty' })
    expect(seams.resolveReference('missing')).toBeUndefined()
    expect(seams.resolveReference('never-seen')).toBeUndefined()
  })

  it('surface extras ride over the shared fields, and alone for a reference nothing loaded', () => {
    const seams = referenceSeams(graph, {
      extra: (ref) => (ref === 'asset:1' ? { image: { href: 'blob:x' } } : undefined),
    })
    expect(seams.resolveReference('asset:1')).toEqual({ image: { href: 'blob:x' } })
    expect(seams.resolveReference('boards/roadmap')).toEqual({ label: 'Roadmap', canvas: board })
  })

  it('a blank body answers no prose and never throws', () => {
    const seams = referenceSeams(graphOf({ bad: { documentId: 'B', name: 'Bad', body: ' ' } }))
    expect(() => seams.resolveEmbed('B')).not.toThrow()
    expect(seams.resolveReference('bad')).toEqual({ label: 'Bad' })
  })
})

describe('referenceWire', () => {
  it('carries a graph, the tables the caller answers over it, and data extras, so the rebuilt seams answer as the originals', () => {
    // The wire is what crosses postMessage: every field is plain data, and
    // the alias/title tables hold exactly the answers the caller's functions
    // gave for what this graph names — so a worker building seams from the
    // wire answers what the main thread's bundle would have.
    const graph = graphOf({
      'notes/plan': { documentId: NOTE_ID, body: 'see [[boards/roadmap]]' },
      'boards/roadmap': { canvas: board },
      'notes/missing': null,
    })
    const wire = referenceWire(graph, {
      resolveAlias: (alias) => (alias === 'boards/roadmap' ? BOARD_ID : null),
      resolveTitle: (id) => (id === BOARD_ID ? 'Roadmap' : id === NOTE_ID ? 'Plan' : undefined),
      extras: new Map([['boards/roadmap', { label: 'Board card' }]]),
    })
    expect(structuredClone(wire)).toEqual(wire)
    expect(wire.aliases).toEqual([['boards/roadmap', BOARD_ID]])
    expect(wire.titles).toEqual(
      expect.arrayContaining([
        [NOTE_ID, 'Plan'],
        [BOARD_ID, 'Roadmap'],
      ]),
    )

    const seams = referenceSeamsFromWire(wire)
    expect(seams.resolveAlias('boards/roadmap')).toBe(BOARD_ID)
    expect(seams.resolveAlias('notes/plan')).toBe(NOTE_ID)
    expect(seams.resolveTitle(BOARD_ID)).toBe('Roadmap')
    expect(seams.resolveTitle(NOTE_ID)).toBe('Plan')
    expect(seams.resolveEmbed(NOTE_ID)?.title).toBe('Plan')
    expect(seams.resolveReference('boards/roadmap')).toEqual({ label: 'Board card', canvas: board })
    expect(seams.resolveReference('notes/missing')).toBeUndefined()
  })
})

describe('overlayReferences', () => {
  it('layers labels and dangling marks over content, and is absent when nothing is supplied', () => {
    expect(overlayReferences({})).toBeUndefined()
    const seam = overlayReferences({
      content: (ref) => (ref === 'a' ? { canvas: board } : undefined),
      labels: new Map([['a', 'Alpha']]),
      missing: new Set(['gone']),
    })
    expect(seam?.('a')).toEqual({ canvas: board, label: 'Alpha' })
    expect(seam?.('gone')).toEqual({ missing: true })
    expect(seam?.('other')).toBeUndefined()
  })
})
