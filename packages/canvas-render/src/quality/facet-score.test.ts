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

/**
 * Per-CHANNEL attribution, and why the columns above cannot answer it.
 *
 * `excess` counts whole TREATMENTS — a `colour|shape` pair — so a board where
 * shape carries the kind cleanly and colour is spent on nothing reports the
 * same number as one where both are muddled. It cannot say WHICH channel is
 * the problem, and that is exactly the question a person has to answer before
 * deciding "colour will mean status, so kind moves to shape".
 *
 * The case that forces it (user, 2026-09-12): an infrastructure diagram wants
 * colour for healthy-vs-failing AND shape for what each component is. Two
 * semantic axes, two channels, and the encoding has to stay uniform within
 * each. Every bundled stencil today writes a COLOUR as well as a silhouette,
 * so applying one spends the channel the status axis needs.
 */
describe('channel attribution', () => {
  // A stencil is what makes a distinction DECLARED — the finding this whole
  // increment came from is that `visual.shape/v0` alone declares nothing, so
  // a board that varies silhouette without a stencil has a contested SHAPE
  // channel and not a carried one. These fixtures therefore dress their
  // boxes; that is also the realistic case.
  const wearing = (kind: string, shape: string, colour?: string) => ({
    ...(colour === undefined ? {} : { color: colour }),
    'x-whiteboard': {
      facets: {
        'visual.stencil/v0': { stencil: kind },
        'visual.shape/v0': { kind: shape },
      },
    },
  })

  // Two kinds, told apart by silhouette alone. Colour is left free — which
  // is what an infrastructure diagram needs if colour is to mean status.
  const byShape = [
    box('api', 0, 0, wearing('visual.gateway', 'hexagon')),
    box('db', 300, 0, wearing('visual.datastore', 'cylinder')),
    box('cache', 600, 0, wearing('visual.datastore', 'cylinder')),
  ]

  it('reads a channel as carried when it is constant within every class and differs across them', () => {
    expect(score(byShape).channels).toEqual({ colour: 'unused', shape: 'carried' })
    expect(score(byShape).contested).toBe(0)
  })

  it('reads a channel as contested when it is spent and no declared partition explains it', () => {
    // The status axis arrives: one datastore goes red because it is failing.
    // Nothing in the document says what red means, and it cuts the kind
    // classes — so colour is spent and unexplained while shape still carries
    // its own distinction. Two axes wanted, one of them undeclared.
    const withStatus = [
      byShape[0] as SpatialNode,
      box('db', 300, 0, wearing('visual.datastore', 'cylinder', '1')),
      byShape[2] as SpatialNode,
    ]
    const s = score(withStatus)
    expect(s.channels).toEqual({ colour: 'contested', shape: 'carried' })
    expect(s.contested).toBe(1)
  })

  it('reads both channels as carried when one partition drives them together', () => {
    // What every bundled stencil does today: it writes a COLOUR as well as a
    // silhouette, from the same kind. Uniform, correct by every column above
    // — and it leaves no free channel for a second axis, which is the
    // conflict none of those columns can see.
    const dressed = [
      box('api', 0, 0, wearing('visual.gateway', 'hexagon', '3')),
      box('db', 300, 0, wearing('visual.datastore', 'cylinder', '5')),
    ]
    expect(score(dressed).channels).toEqual({ colour: 'carried', shape: 'carried' })
    expect(score(dressed).contested).toBe(0)
  })

  it('reads a channel as unused rather than contested when the board never spends it', () => {
    expect(score(plain).channels).toEqual({ colour: 'unused', shape: 'unused' })
    expect(score(plain).contested).toBe(0)
  })
})

/**
 * A board declaring its OWN axis.
 *
 * Until now the only distinctions this score could see were the three it
 * knows by name: which frame holds a box, the node's kind, and the stencil it
 * wears. Anything else a document says about its boxes — that these are
 * failing and those are healthy, that these are ours and those are a
 * vendor's — was invisible, so a colour spent on it read as `contested`: a
 * distinction the reader sees and the document does not state. It DID state
 * it; the instrument could not hear it.
 *
 * That is what stops a second semantic axis existing at all (user,
 * 2026-09-12): an infrastructure diagram wants shape for what a component is
 * and colour for whether it is healthy, and the second one had nowhere to be
 * declared. `visual.axes/v0` is where — a canvas names the facet keys it
 * treats as axes, and each becomes a partition like the three built in.
 *
 * Deliberately NOT "any facet is an axis". `visual.shape/v0` is a facet and
 * is emphatically not a construct — it says what a box DRAWS, not what it
 * IS, and counting it would make every silhouette its own declared class.
 * The document has to say which of its facets carry meaning, because nothing
 * about a facet's shape reveals that.
 */
describe('a canvas declares its own axes', () => {
  const withStatus = (status: string) => ({
    'x-whiteboard': { facets: { 'ops.status/v0': { state: status } } },
  })
  const axes = (...keys: readonly string[]) => ({
    'x-whiteboard': { facets: { 'visual.axes/v0': { axes: [...keys] } } },
  })

  const boxes = [
    box('api', 0, 0, { color: '4', ...withStatus('healthy') }),
    box('db', 300, 0, { color: '4', ...withStatus('healthy') }),
    box('cache', 600, 0, { color: '1', ...withStatus('failing') }),
  ]

  it('reads a declared axis as a partition, so a colour spent on it is carried', () => {
    const declared = scoreFacets({
      nodes: [...boxes],
      edges: [],
      ...axes('ops.status/v0'),
    } as unknown as SpatialCanvas)
    expect(declared.channels.colour).toBe('carried')
    expect(declared.contested).toBe(0)
  })

  it('says the same board is contested when the axis is not declared', () => {
    // The mutation is the DECLARATION, not the drawing: identical boxes, and
    // the only difference is whether the canvas says what the colour means.
    const undeclared = scoreFacets({ nodes: [...boxes], edges: [] } as unknown as SpatialCanvas)
    expect(undeclared.channels.colour).toBe('contested')
    expect(undeclared.contested).toBe(1)
  })

  it('ignores an axis no box carries, rather than inventing an empty construct', () => {
    const stray = scoreFacets({
      nodes: [...boxes],
      edges: [],
      ...axes('ops.nothing/v0'),
    } as unknown as SpatialCanvas)
    expect(stray.channels.colour).toBe('contested')
  })
})
