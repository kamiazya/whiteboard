import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { fileNode, groupNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import { layoutSpatialCanvas } from '../layout/spatial-canvas.js'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import { testLayoutCore } from '../test-utils/test-layout-core.js'
import { createSpatialTheme } from '../theme/spatial-theme.js'
import type { LoadedReference, ReferenceGraph } from './loaded-reference.js'
import { referenceSeams } from './seams.js'
import { imageTargets, REFERENCE_BUDGET, referenceTargets } from './targets.js'
import {
  overlayReferences,
  type ReferenceExtra,
  referenceSeamsFromWire,
  referenceWire,
  referenceWireFor,
  wireOfSeams,
} from './wire.js'

const NOTE_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const BOARD_ID = '01BX5ZZKBKACTAV9WEVGEMMVRZ'

const board: SpatialCanvas = {
  nodes: [textNode({ id: 'n1', x: 0, y: 0, width: 200, height: 100, text: 'on the board' })],
  edges: [],
}

function graphOf(entries: Record<string, LoadedReference | null>): ReferenceGraph {
  return new Map(Object.entries(entries))
}

/**
 * What the core draws for one file node of `file`, over the wire `wire`:
 * the scene as JSON, since the assertions are about what text and images
 * reach it, which is what a reader sees.
 */
function drawnFile(wire: ReturnType<typeof referenceWire>, file: string): string {
  const canvas: SpatialCanvas = {
    nodes: [fileNode({ id: 'f', x: 0, y: 0, width: 400, height: 300, file })],
    edges: [],
  }
  const scene = layoutSpatialCanvas(canvas, {
    core: testLayoutCore(),
    measure: createFakeMeasure(),
    appearance: createSpatialTheme({ mode: 'light' }),
    expandFileNode: () => true,
    references: referenceSeamsFromWire(wire),
  })
  return JSON.stringify(scene)
}

/**
 * The counterpart question to `referenceTargets`: not "what documents does
 * this render need" but "what stored PICTURES does it need". It is separate
 * because the two answers are disjoint by construction — `referenceTargets`
 * subtracts image assets, since an asset is not a document — and because a
 * body's inline `![](asset:…)` is invisible to the wikilink scanner that
 * answers the first, so before this the seam a body asks could never be
 * answered for one.
 */
describe('imageTargets', () => {
  it('names a frame background, since the layout draws it', () => {
    const canvas: SpatialCanvas = {
      nodes: [
        groupNode({
          id: 'g',
          x: 0,
          y: 0,
          width: 300,
          height: 200,
          label: 'F',
          background: 'asset:frame-bg',
        }),
        groupNode({ id: 'plain', x: 0, y: 0, width: 10, height: 10, background: 'boards/x' }),
      ],
      edges: [],
    }
    expect(imageTargets({ canvases: [canvas] })).toEqual(['asset:frame-bg'])
  })

  it("names a canvas's image file nodes and a body's inline images alike", () => {
    const canvas: SpatialCanvas = {
      nodes: [
        fileNode({ id: 'i', x: 0, y: 0, width: 10, height: 10, file: 'asset:on-canvas' }),
        fileNode({ id: 'f', x: 0, y: 0, width: 10, height: 10, file: 'boards/roadmap' }),
      ],
      edges: [],
    }
    expect(
      imageTargets({ canvases: [canvas], bodies: ['before ![alt](asset:in-body) after'] }),
    ).toEqual(['asset:in-body', 'asset:on-canvas'])
  })

  it("names what a canvas's TEXT nodes write inline, which is the case that was lost", () => {
    // A text node's body is laid out with the same seams a note's is, so its
    // inline image is drawn — but nothing collected it, so nothing loaded it.
    const withText: SpatialCanvas = {
      nodes: [
        textNode({ id: 't', x: 0, y: 0, width: 10, height: 10, text: '![](asset:in-text-node)' }),
      ],
      edges: [],
    }
    expect(imageTargets({ canvases: [withText] })).toEqual(['asset:in-text-node'])
  })

  it("follows what has loaded, so an embedded note's picture loads too", () => {
    expect(
      imageTargets({
        bodies: ['![[notes/plan]]'],
        loaded: graphOf({ 'notes/plan': { documentId: NOTE_ID, body: '![](asset:deep)' } }),
      }),
    ).toEqual(['asset:deep'])
  })

  it("follows what has loaded, so an embedded board's picture loads too", () => {
    const pictured: SpatialCanvas = {
      nodes: [fileNode({ id: 'p', x: 0, y: 0, width: 100, height: 100, file: 'asset:on-board' })],
      edges: [],
    }
    expect(
      imageTargets({
        bodies: ['![[boards/b]]'],
        loaded: graphOf({ 'boards/b': { documentId: BOARD_ID, canvas: pictured } }),
      }),
    ).toEqual(['asset:on-board'])
  })

  it('reads an angle-bracket destination, which is what the parser sees', () => {
    // Measured against `parseMarkdownBody`: `![a](<asset:abc>)` yields the mdast
    // url `asset:abc`, so the layout asks for it — a scan that kept the
    // brackets skipped the load and the picture silently did not draw, which
    // is the one direction this scan is not allowed to be cheap in. Angle
    // brackets also permit a SPACE, where a bare destination cannot.
    expect(imageTargets({ bodies: ['![a](<asset:abc>) ![b](<asset:two words>)'] })).toEqual([
      'asset:abc',
      'asset:two words',
    ])
  })

  it('stops at the same budget the document walk does', () => {
    // `referenceTargets` bounds itself at REFERENCE_BUDGET so a link-dense
    // workspace is never loaded whole. Sharing that walk without sharing the
    // bound left this set unbounded, and a keeper starts one read per entry.
    const many = Array.from({ length: REFERENCE_BUDGET + 50 }, (_, i) => `![](asset:${i})`).join(
      ' ',
    )
    expect(imageTargets({ bodies: [many] })).toHaveLength(REFERENCE_BUDGET)
  })

  /**
   * A body is untrusted input, and the first version of this scan was a regex
   * whose inner `[^\]]*` re-attempted at every `![`. Quadratic, and caught by
   * CodeQL as `js/polynomial-redos` (high) rather than by anything here.
   *
   * The FIXTURE is the part worth reading. `'!['.repeat(n)` alone proves
   * nothing — it holds no `](`, so the cheap gate returns before either
   * version scans, and the first guard written here passed against the
   * restored regex. What reaches the scan is a body that opens with a real
   * image and then repeats `![`, which is an ordinary shape: measured on the
   * regex, 37ms at 5000, 568ms at 20000, 2328ms at 40000. The forward pass
   * does the 40000 case in under a tenth of a millisecond.
   *
   * The ceiling sits four orders of magnitude above that measurement and one
   * below the regression, which is what makes it decisive under a loaded
   * parallel run rather than a timing test that flakes.
   */
  it('scans a pathological body in linear time', () => {
    const body = `![a](asset:real) ${'!['.repeat(40_000)}`
    const started = performance.now()
    expect(imageTargets({ bodies: [body] })).toEqual(['asset:real'])
    expect(performance.now() - started).toBeLessThan(500)
  })

  it('ignores a URL no keeper holds, which needs no resolution anyway', () => {
    // An absolute URL already draws, and a bare path is a separate question
    // (relative to WHAT), so neither is asked for. Asking would be a load
    // that can only fail.
    expect(
      imageTargets({ bodies: ['![](https://example.com/a.png) ![](./b.png) [](asset:link)'] }),
    ).toEqual([])
  })
})

describe('referenceTargets', () => {
  it("names a body's links and embeds, a canvas's file nodes, and what loaded bodies name", () => {
    const canvas: SpatialCanvas = {
      nodes: [
        fileNode({ id: 'f', x: 0, y: 0, width: 10, height: 10, file: 'boards/roadmap' }),
        fileNode({ id: 'i', x: 0, y: 0, width: 10, height: 10, file: 'asset:abc' }),
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
      nodes: [fileNode({ id: 'f', x: 0, y: 0, width: 10, height: 10, file: 'boards/b' })],
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
      nodes: [textNode({ id: 't', x: 0, y: 0, width: 10, height: 10, text: 'see ![[notes/a]]' })],
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

  it("leaves a body's image embeds out, so the budget is spent on documents", () => {
    // `![[asset:…]]` scans as an embed, but a stored picture is not a
    // document: asking a keeper for it as one costs a lookup that answers
    // nothing, and every such ref would push a real document past the budget.
    const pictures = Array.from({ length: REFERENCE_BUDGET }, (_, i) => `![[asset:p${i}]]`)
    expect(referenceTargets({ bodies: ['![[asset:abc]] and [[note]]'] })).toEqual(['note'])
    expect(referenceTargets({ bodies: [`${pictures.join(' ')} [[after]]`] })).toEqual(['after'])
    const withText: SpatialCanvas = {
      nodes: [textNode({ id: 't', x: 0, y: 0, width: 10, height: 10, text: '![[asset:x]]' })],
      edges: [],
    }
    expect(referenceTargets({ canvases: [withText] })).toEqual([])
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

  it('hands the core the wire it was rebuilt from, and no other bundle', () => {
    const wire = referenceWire(graph)
    const seams = referenceSeamsFromWire(wire)
    expect(wireOfSeams(seams)).toBe(wire)
    expect(wireOfSeams(referenceSeams(graph))).toBeUndefined()
  })
})

describe('what the core draws of a reference record', () => {
  const graph = graphOf({
    'notes/plan': { documentId: NOTE_ID, name: 'The Plan', body: '## Launch\n\nbody text' },
    'boards/roadmap': { documentId: BOARD_ID, name: 'Roadmap', canvas: board },
  })

  it('draws a spatial record as its canvas, and a markdown record as its prose', () => {
    const wire = referenceWire(graph)
    expect(drawnFile(wire, 'boards/roadmap')).toContain('on the board')
    const note = drawnFile(wire, 'notes/plan')
    expect(note).toContain('Launch')
    expect(note).toContain('The Plan')
  })

  it('a record with a body is markdown even when it also carries a canvas', () => {
    const wire = referenceWire(
      graphOf({ legacy: { documentId: 'L', body: 'prose', canvas: board } }),
    )
    const drawn = drawnFile(wire, 'legacy')
    expect(drawn).toContain('prose')
    expect(drawn).not.toContain('on the board')
  })

  it('draws an empty canvas as the card, and a blank body as the label alone', () => {
    const empty = referenceWire(graphOf({ e: { name: 'Empty', canvas: { nodes: [], edges: [] } } }))
    expect(drawnFile(empty, 'e')).toContain('Empty')
    const blank = referenceWire(graphOf({ bad: { documentId: 'B', name: 'Bad', body: ' ' } }))
    expect(() => drawnFile(blank, 'bad')).not.toThrow()
    expect(drawnFile(blank, 'bad')).toContain('Bad')
  })

  it('draws a surface extra over the record, and alone for a reference nothing loaded', () => {
    const wire = referenceWire(graph, {
      extras: new Map<string, ReferenceExtra>([
        ['asset:1', { image: { href: 'blob:x' } }],
        ['boards/roadmap', { label: 'Board card' }],
      ]),
    })
    expect(drawnFile(wire, 'asset:1')).toContain('blob:x')
    const card = drawnFile(wire, 'boards/roadmap')
    expect(card).toContain('Board card')
    expect(card).toContain('on the board')
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
    expect(wireOfSeams(seams)).toEqual(wire)
    expect(drawnFile(wire, 'boards/roadmap')).toContain('Board card')
    expect(drawnFile(wire, 'boards/roadmap')).toContain('on the board')
  })

  it('marks the targets still loading pending, asks the tables of them, and keeps the marks on the wire the core reads', () => {
    // A target written by path is still loading: the alias table must be
    // asked of it, or an embed naming its id could not be told it is loading.
    const wire = referenceWire(graphOf({ 'notes/plan': { documentId: NOTE_ID, body: 'x' } }), {
      resolveAlias: (alias) => (alias === 'boards/roadmap' ? BOARD_ID : null),
      resolveTitle: (id) => (id === BOARD_ID ? 'Roadmap' : undefined),
      extras: new Map([['boards/roadmap', { label: 'Board card' }]]),
      pending: new Set(['boards/roadmap', 'notes/plan']),
    })
    expect(structuredClone(wire)).toEqual(wire)
    expect(wire.aliases).toEqual([['boards/roadmap', BOARD_ID]])
    expect(wire.titles).toEqual([[BOARD_ID, 'Roadmap']])
    expect(wire.extras).toEqual([
      ['boards/roadmap', { label: 'Board card', pending: true }],
      ['notes/plan', { pending: true }],
    ])
    // The core is handed these bytes, which is where an embed of the id
    // learns it is loading.
    expect(wireOfSeams(referenceSeamsFromWire(wire))?.extras).toEqual(wire.extras)
    expect(referenceWire(new Map()).extras).toEqual([])
    const quiet = referenceWire(graphOf({ 'notes/plan': { documentId: NOTE_ID, body: 'x' } }))
    expect(quiet.extras).toEqual([])
  })

  it('asks the tables of every link the seeds write, past the loading budget too', () => {
    // REFERENCE_BUDGET bounds what is LOADED; an alias costs no load, so a
    // link the walk never reached still resolves and keeps its name.
    const idOf = (i: number) => `01BX5ZZKBKACTAV9WEVG${String(i).padStart(6, '0')}`
    const count = REFERENCE_BUDGET + 44
    const body = Array.from({ length: count }, (_, i) => `[[note-${i}]] [[${idOf(1000 + i)}]]`)
    const loaded = graphOf({ 'note-0': { body: 'see [[nested-past]]' } })
    const wire = referenceWire(loaded, {
      resolveAlias: (alias) => (alias.startsWith('note-') ? idOf(Number(alias.slice(5))) : null),
      resolveTitle: (id) => `T${Number(id.slice(20))}`,
      seeds: { bodies: [body.join(' ')] },
    })
    const last = count - 1
    expect(wire.aliases).toContainEqual([`note-${last}`, idOf(last)])
    expect(wire.titles).toContainEqual([idOf(last), `T${last}`])
    // A link written by id names itself, so only its title has to ride.
    expect(wire.titles).toContainEqual([idOf(1000 + last), `T${1000 + last}`])
    const seams = referenceSeamsFromWire(wire)
    expect(seams.resolveAlias(`note-${last}`)).toBe(idOf(last))
    // The cut a canvas layout takes keeps them as well.
    const canvas: SpatialCanvas = {
      nodes: [textNode({ id: 't', x: 0, y: 0, width: 9, height: 9, text: body.join(' ') })],
      edges: [],
    }
    const onBoard = referenceWire(loaded, {
      resolveAlias: (alias) => (alias.startsWith('note-') ? idOf(Number(alias.slice(5))) : null),
      resolveTitle: (id) => `T${Number(id.slice(20))}`,
      seeds: { canvases: [canvas] },
    })
    const cut = referenceWireFor(onBoard, { canvases: [canvas] })
    expect(cut.aliases).toContainEqual([`note-${last}`, idOf(last)])
    expect(cut.titles).toContainEqual([idOf(1000 + last), `T${1000 + last}`])
  })

  it('draws the last extra of a key, an empty one included, as the reference alone', () => {
    const extras: [string, ReferenceExtra][] = [
      ['a', { label: 'Extra' }],
      ['a', {}],
    ]
    const drawn = drawnFile({ ...referenceWire(new Map()), extras }, 'a')
    expect(drawn).not.toContain('Extra')
  })
})

describe('overlayReferences', () => {
  it('layers labels and dangling marks over what the wire resolves, as extras that cross as data', () => {
    const empty = referenceWire(new Map())
    expect(overlayReferences(empty, {})).toBe(empty)
    const wire = referenceWire(graphOf({ a: { name: 'From the record', canvas: board } }), {
      extras: new Map([['asset:p', { image: { href: 'blob:a' } }]]),
    })
    const overlaid = overlayReferences(wire, {
      labels: new Map([['a', 'Alpha']]),
      missing: new Set(['gone']),
    })
    // Plain data: survives a structured clone, which is what a worker and the core receive.
    const crossed = structuredClone(overlaid)
    expect(drawnFile(crossed, 'a')).toContain('Alpha')
    expect(drawnFile(crossed, 'a')).not.toContain('From the record')
    expect(drawnFile(crossed, 'asset:p')).toContain('blob:a')
    expect(drawnFile(crossed, 'gone')).toContain('Missing reference')
    expect(drawnFile(crossed, 'other')).not.toContain('Missing reference')
  })
})

describe('referenceWireFor', () => {
  it('keeps the rows laying out these canvases can read — what they name, transitively — and drops the rest', () => {
    // The hook that feeds the editor grows its wire for a body being DRAFTED
    // beside the canvas, so the overlay's preview resolves it before the
    // commit. The canvas's own layout cannot read those rows, and it must not
    // re-lay out or drop its content cache for them.
    const OTHER_ID = '01CX5ZZKBKACTAV9WEVGEMMVRZ'
    const canvas: SpatialCanvas = {
      nodes: [
        textNode({ id: 't', x: 0, y: 0, width: 200, height: 100, text: 'see [[notes/plan]]' }),
        fileNode({ id: 'f', x: 0, y: 0, width: 10, height: 10, file: 'asset:pic' }),
      ],
      edges: [],
    }
    const wire = referenceWire(
      graphOf({
        'notes/plan': { documentId: NOTE_ID, body: '![[boards/roadmap]]' },
        'boards/roadmap': { documentId: BOARD_ID, canvas: board },
        'notes/drafted': { documentId: OTHER_ID, body: 'typed, not committed' },
        'notes/gone': null,
      }),
      {
        resolveAlias: (alias) => (alias === 'notes/drafted' ? OTHER_ID : null),
        resolveTitle: (id) =>
          id === NOTE_ID
            ? 'Plan'
            : id === BOARD_ID
              ? 'Roadmap'
              : id === OTHER_ID
                ? 'Drafted'
                : undefined,
        extras: new Map([
          ['asset:pic', { image: { href: 'blob:pic' } }],
          ['notes/drafted', { label: 'Drafted card' }],
        ]),
      },
    )

    const own = referenceWireFor(wire, { canvases: [canvas] })
    expect(own.entries.map(([key]) => key).sort()).toEqual(['boards/roadmap', 'notes/plan'])
    expect(own.aliases).toEqual([])
    expect(own.titles.map(([id]) => id).sort()).toEqual([BOARD_ID, NOTE_ID].sort())
    expect(own.extras).toEqual([['asset:pic', { image: { href: 'blob:pic' } }]])
    // A wire the canvas cannot read more of is the same wire, byte for byte.
    expect(JSON.stringify(referenceWireFor(own, { canvases: [canvas] }))).toBe(JSON.stringify(own))
    expect(structuredClone(own)).toEqual(own)
  })

  it('keeps the picture extras a frame background and an inline image ask for', () => {
    const canvas: SpatialCanvas = {
      nodes: [
        groupNode({
          id: 'g',
          x: 0,
          y: 0,
          width: 300,
          height: 200,
          label: 'F',
          background: 'asset:bg',
        }),
        fileNode({ id: 'f', x: 0, y: 0, width: 10, height: 10, file: 'asset:file' }),
        textNode({
          id: 't',
          x: 0,
          y: 0,
          width: 200,
          height: 100,
          text: 'hi ![x](asset:inline)',
        }),
      ],
      edges: [],
    }
    const wire = referenceWire(graphOf({}), {
      extras: new Map([
        ['asset:bg', { image: { href: 'blob:bg' } }],
        ['asset:file', { image: { href: 'blob:file' } }],
        ['asset:inline', { image: { href: 'blob:inline' } }],
        ['asset:body', { image: { href: 'blob:body' } }],
        ['asset:unused', { image: { href: 'blob:unused' } }],
      ]),
    })
    const own = referenceWireFor(wire, { canvases: [canvas], bodies: ['![b](asset:body)'] })
    expect(own.extras.map(([key]) => key).sort()).toEqual([
      'asset:bg',
      'asset:body',
      'asset:file',
      'asset:inline',
    ])
  })

  it('keeps a row the canvas names even when nothing loaded for it, and an alias a body wrote', () => {
    const canvas: SpatialCanvas = {
      nodes: [
        textNode({
          id: 't',
          x: 0,
          y: 0,
          width: 200,
          height: 100,
          text: '[[notes/gone]] [[notes/plan]]',
        }),
      ],
      edges: [],
    }
    const wire = referenceWire(graphOf({ 'notes/gone': null, 'notes/plan': { body: 'x' } }), {
      resolveAlias: (alias) => (alias === 'notes/plan' ? NOTE_ID : null),
      resolveTitle: (id) => (id === NOTE_ID ? 'Plan' : undefined),
    })
    const own = referenceWireFor(wire, { canvases: [canvas] })
    expect(own.entries).toEqual(expect.arrayContaining([['notes/gone', null]]))
    expect(own.aliases).toEqual([['notes/plan', NOTE_ID]])
    expect(own.titles).toEqual([[NOTE_ID, 'Plan']])
  })
})
