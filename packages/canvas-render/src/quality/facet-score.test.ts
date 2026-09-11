// Calibration of the facet-vocabulary score against KNOWN truths, the shape
// `drawing-score.test.ts` and `composition-score.test.ts` both use: a board
// with one planted mistake reports it in the column that names it and
// nowhere else. An instrument trusted before it is calibrated is how
// `worstStallMs` came to report 0.3ms for a 200ms stall.
//
// ADR-0033 fixes what these columns may be read to mean: whether the
// distinctions a reader can SEE match the ones the document DECLARES —
// never that the drawing was understood, and never that the distinction
// drawn was the right one to draw.
import type { SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { type FacetScore, scoreFacets } from './facet-score.js'

const box = (
  id: string,
  x: number,
  y: number,
  extra: Partial<SpatialNode> & Record<string, unknown> = {},
): SpatialNode =>
  ({ id, type: 'text', x, y, width: 200, height: 80, text: id, ...extra }) as SpatialNode

const frame = (id: string, x: number, y: number, width: number, height: number): SpatialNode =>
  ({ id, type: 'group', x, y, width, height, label: id }) as SpatialNode

const shaped = (kind: string) => ({
  'x-whiteboard': { facets: { 'visual.shape/v0': { kind } } },
})
const badged = (char: string) => ({
  'x-whiteboard': { facets: { 'visual.symbol/v0': { kind: 'emoji', char } } },
})

const canvasOf = (nodes: readonly SpatialNode[]): SpatialCanvas =>
  ({ nodes: [...nodes], edges: [] }) as SpatialCanvas
const score = (nodes: readonly SpatialNode[]): FacetScore => scoreFacets(canvasOf(nodes))

// Two frames, two boxes each. One declared partition with two classes, and
// nothing spent on appearance — the shape almost every board in the corpus
// actually has.
const plain = [
  frame('left', 0, 0, 480, 200),
  frame('right', 600, 0, 480, 200),
  box('a', 40, 60),
  box('b', 260, 60),
  box('c', 640, 60),
  box('d', 860, 60),
]

describe('facet vocabulary: what the document declares', () => {
  it('reads a frame membership and a node kind as partitions, and nothing else as one', () => {
    const s = score(plain)
    // Frames only: every box is a `text`, so the kind partition has one
    // class and says nothing.
    expect(s.partitions).toBe(1)
    expect(s.constructs).toBe(2)
  })

  it('is silent on a board that declares nothing, which is the blind spot', () => {
    // No frame and one kind: there is no distinction to be visible about, so
    // every column reads zero on a board that may still be badly drawn.
    // Pinned rather than papered over, as the composition axis pins its own.
    const s = score([box('a', 0, 0), box('b', 300, 0)])
    expect([s.partitions, s.constructs, s.deficit, s.overload, s.excess]).toEqual([0, 0, 0, 0, 0])
  })

  it('drops a frame that holds every box, since it distinguishes nothing', () => {
    const s = score([frame('all', 0, 0, 900, 200), box('a', 40, 60), box('b', 400, 60)])
    expect(s.partitions).toBe(0)
  })
})

describe('facet vocabulary: a planted mistake moves the column that names it', () => {
  it('a construct nothing visible carries is DEFICIT, and only that', () => {
    // Both classes plain: both are owed.
    const s = score(plain)
    expect(s.deficit).toBe(2)
    expect([s.overload, s.excess, s.redundancy]).toEqual([0, 0, 0])
    // ...and colouring one class by itself clears half of it.
    const half = score([
      ...plain.slice(0, 2),
      box('a', 40, 60, { color: '4' }),
      box('b', 260, 60, { color: '4' }),
      ...plain.slice(4),
    ])
    expect(half.deficit).toBe(1)
    expect([half.overload, half.excess]).toEqual([0, 0])
  })

  it('one treatment across two constructs is OVERLOAD, and only that', () => {
    const s = score([
      ...plain.slice(0, 2),
      box('a', 40, 60, { color: '4' }),
      box('b', 260, 60, { color: '4' }),
      box('c', 640, 60, { color: '4' }),
      box('d', 860, 60, { color: '4' }),
    ])
    expect(s.overload).toBe(1)
    // Every construct is carried, so nothing is owed as deficit — the
    // failure is that what carries them does not tell them apart.
    expect([s.deficit, s.excess]).toEqual([0, 0])
  })

  it('a treatment matching no construct is EXCESS, and only that', () => {
    // One box from each frame shares a colour: that set is inside no class
    // of any partition, so a reader sees a distinction the document does
    // not declare.
    const s = score([
      ...plain.slice(0, 2),
      box('a', 40, 60, { color: '4' }),
      box('b', 260, 60),
      box('c', 640, 60, { color: '4' }),
      box('d', 860, 60),
    ])
    expect(s.excess).toBe(1)
    expect(s.deficit).toBe(0)
  })

  it('two channels on one distinction is REDUNDANCY, reported and not owed', () => {
    // Colour AND silhouette per class: Moody's fourth case, which the
    // redundant-encoding work says reads BETTER rather than worse.
    const s = score([
      ...plain.slice(0, 2),
      box('a', 40, 60, { color: '4', ...shaped('hexagon') }),
      box('b', 260, 60, { color: '4' }),
      box('c', 640, 60, { color: '2' }),
      box('d', 860, 60, { color: '2' }),
    ])
    expect(s.redundancy).toBe(1)
    expect([s.deficit, s.overload, s.excess]).toEqual([0, 0, 0])
  })
})

describe('facet vocabulary: discriminability', () => {
  it('counts the FEWEST channels two treatments in use differ on', () => {
    const oneChannel = score([
      ...plain.slice(0, 2),
      box('a', 40, 60, { color: '4' }),
      box('b', 260, 60, { color: '4' }),
      box('c', 640, 60, { color: '2' }),
      box('d', 860, 60, { color: '2' }),
    ])
    expect(oneChannel.distance).toBe(1)
    const twoChannels = score([
      ...plain.slice(0, 2),
      box('a', 40, 60, { color: '4', ...shaped('hexagon') }),
      box('b', 260, 60, { color: '4', ...shaped('hexagon') }),
      box('c', 640, 60, { color: '2' }),
      box('d', 860, 60, { color: '2' }),
    ])
    expect(twoChannels.distance).toBe(2)
  })

  it('reads a board that spends nothing as distance 0 and one treatment', () => {
    // 0 is "there is nothing to tell apart", not "two symbols collide":
    // two DISTINCT treatments differ on at least one channel by
    // construction, so the value cannot mean both.
    const s = score(plain)
    expect([s.distance, s.treatments]).toEqual([0, 1])
  })

  it('counts the plain default among the treatments a reader must hold', () => {
    const s = score([
      ...plain.slice(0, 2),
      box('a', 40, 60, { color: '4' }),
      box('b', 260, 60),
      box('c', 640, 60),
      box('d', 860, 60),
    ])
    expect(s.treatments).toBe(2)
    expect(s.distance).toBe(1)
  })
})

describe('facet vocabulary: a stencil is a declared distinction', () => {
  // ADR-0034 decision 5's load-bearing half. A stencil EXPANDS onto the node
  // (so every reader draws it) and RECORDS which one it was — and the record
  // is a partition the document states about its own boxes. Without reading
  // it, a board dressed by kind shows distinctions matching nothing declared,
  // which is exactly `excess`: the axis would score a real improvement as a
  // defect.
  const stencilled = (id: string) => ({
    'x-whiteboard': { facets: { 'visual.stencil/v0': { stencil: id } } },
  })
  const dressed = (id: string, colour: string, shape: string) => ({
    ...stencilled(id),
    color: colour,
    'x-whiteboard': {
      facets: {
        'visual.stencil/v0': { stencil: id },
        'visual.shape/v0': { kind: shape },
      },
    },
  })

  it('reads the stencil a node wears as a partition, so a dressed board owes nothing', () => {
    // Two frames, and each frame's boxes dressed as one kind. Under frames
    // alone this is two carried constructs; the stencil partition agrees
    // with it rather than cutting it, so nothing is owed and nothing is
    // excess.
    const s = score([
      ...plain.slice(0, 2),
      box('a', 40, 60, dressed('visual.datastore', '5', 'cylinder')),
      box('b', 260, 60, dressed('visual.datastore', '5', 'cylinder')),
      box('c', 640, 60, dressed('visual.queue', '6', 'parallelogram')),
      box('d', 860, 60, dressed('visual.queue', '6', 'parallelogram')),
    ])
    expect([s.deficit, s.overload, s.excess]).toEqual([0, 0, 0])
    expect(s.treatments).toBe(2)
  })

  it('is what keeps a board dressed ACROSS frames out of the excess column', () => {
    // The case the record exists for: one box of each frame is a datastore.
    // By frame membership alone that appearance cuts both classes and reads
    // as `excess` — a distinction the reader looks for and does not find.
    // The stencil the document names IS that distinction, so it is declared.
    const nodes = [
      ...plain.slice(0, 2),
      box('a', 40, 60, dressed('visual.datastore', '5', 'cylinder')),
      box('b', 260, 60),
      box('c', 640, 60, dressed('visual.datastore', '5', 'cylinder')),
      box('d', 860, 60),
    ]
    expect(score(nodes).excess).toBe(0)
  })

  it('counts a stencil partition only when the board declares two of them', () => {
    // One stencil across every box distinguishes nothing, exactly as one
    // frame holding every box does.
    const s = score([
      box('a', 0, 0, dressed('visual.service', '4', 'hexagon')),
      box('b', 300, 0, dressed('visual.service', '4', 'hexagon')),
    ])
    expect([s.partitions, s.constructs]).toEqual([0, 0])
  })

  it('ignores a record naming a stencil with no appearance on the node', () => {
    // A record without the expansion is a claim the drawing does not make.
    // It still DECLARES the partition — the document says these differ — so
    // the board owes the constructs rather than being let off them.
    const s = score([
      ...plain.slice(0, 2),
      box('a', 40, 60, stencilled('visual.datastore')),
      box('b', 260, 60, stencilled('visual.datastore')),
      box('c', 640, 60, stencilled('visual.queue')),
      box('d', 860, 60, stencilled('visual.queue')),
    ])
    expect(s.deficit).toBe(s.constructs)
    expect(s.treatments).toBe(1)
  })
})

describe('facet vocabulary: what carries a distinction, and what does not', () => {
  it('does NOT read a badge as a distinction, because a board does not draw one', () => {
    // Corrected after looking at a picture. `visual.symbol` was listed as one
    // of three channels that can say "these differ in kind", and on a BOARD
    // it says nothing: `plugin-visual` contributes no node decoration — the
    // badge was deliberately removed once the small surfaces it was designed
    // for existed, since at full size it repeated what the node already
    // showed. The only thing that draws a node's symbol is the minimap.
    //
    // So counting it credited a distinction no reader of this canvas can
    // see. Found by rendering a board a model actually drew and noticing two
    // stencils' badges were simply absent, while the score read them as
    // spent — invisible in the SVG text, obvious in the image.
    const s = score([
      ...plain.slice(0, 2),
      box('a', 40, 60, badged('\u{1f512}')),
      box('b', 260, 60, badged('\u{1f512}')),
      box('c', 640, 60),
      box('d', 860, 60),
    ])
    expect(s.deficit).toBe(2)
    expect(s.treatments).toBe(1)
  })

  it('does NOT read text alignment as a distinction', () => {
    // `visual.text/v0` is placement, not kind — a board that sets it on one
    // frame's boxes has still said nothing about how they differ.
    const aligned = {
      'x-whiteboard': { facets: { 'visual.text/v0': { align: 'center' } } },
    }
    const s = score([
      ...plain.slice(0, 2),
      box('a', 40, 60, aligned),
      box('b', 260, 60, aligned),
      box('c', 640, 60),
      box('d', 860, 60),
    ])
    expect(s.deficit).toBe(2)
    expect(s.treatments).toBe(1)
  })

  it('ignores an unresolvable facet payload, exactly as the renderer does', () => {
    // The resolvers this reads through are the renderer's own, so a payload
    // that would draw no silhouette scores as no silhouette. A second,
    // hand-rolled reader here is how a score and a picture come apart.
    const s = score([
      ...plain.slice(0, 2),
      box('a', 40, 60, {
        'x-whiteboard': { facets: { 'visual.shape/v0': { kind: 'not-a-shape' } } },
      }),
      box('b', 260, 60),
      box('c', 640, 60),
      box('d', 860, 60),
    ])
    expect(s.treatments).toBe(1)
    expect(s.deficit).toBe(2)
  })
})
