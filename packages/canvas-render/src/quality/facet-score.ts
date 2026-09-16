/**
 * The facet-vocabulary axis of
 * [ADR-0033](../../../../docs/contributing/adr/0033-facet-vocabulary-axis.md):
 * whether the distinctions a reader can SEE line up with the distinctions the
 * document DECLARES. Scored beside the drawing score and the composition
 * axis, never mixed into either.
 *
 * Those two read GEOMETRY — where the boxes sit, how the lines run. A drawing
 * also distinguishes things by APPEARANCE, which says two things differ in
 * KIND rather than in position, and nothing else here measures it. Measured
 * before this was written: the whole drawing corpus spends zero colours and
 * zero facets, so the channel is not merely under-used, it is unspent.
 *
 * **What it measures, and what it does not.** It measures whether visible
 * distinctions match declared ones. It does NOT measure whether a reader
 * understood the drawing, whether the distinction the author chose was the
 * RIGHT one to draw (a board coloured by team scores perfectly and answers
 * the wrong question for a reader who cares about latency), or whether the
 * particular colour or icon was well chosen. Its source is Moody's *The
 * Physics of Notations* (IEEE TSE 2009), whose own critics note that
 * applying it properly usually needs user involvement this repository cannot
 * supply — so the claim stays at the level the counting supports.
 *
 * **More facets is NOT better**, and the columns are shaped so a board
 * cannot score well by spending more: an appearance matching no declared
 * distinction is `excess`, and one appearance carrying two is `overload`.
 */

import { facetPayloadKey } from '@kamiazya/whiteboard-facet-engine'
import {
  type CanvasEdge,
  parseScopedTag,
  type SpatialCanvas,
  type SpatialNode,
} from '@kamiazya/whiteboard-model'
import {
  resolveNodeShape,
  resolveNodeStencil,
  VISUAL_AXES_KEY,
} from '@kamiazya/whiteboard-plugin-visual'

export interface FacetScore {
  /**
   * What the document DECLARES: the partitions of its boxes it states, and
   * the classes (Moody's CONSTRUCTS) across them.
   *
   * Three sources are read — a frame's membership, a node's kind, and the
   * STENCIL a node records wearing ([ADR-0034](../../../../docs/contributing/adr/0034-stencil-and-recipe.md)
   * decision 5). A fourth is declared by ADR-0033 and deliberately not
   * computed here: a file node's referenced OKF `type` needs the reference
   * bundle a composition root supplies, which this function does not
   * receive.
   *
   * The stencil source is what makes a dressed board legible rather than
   * merely decorated, and measured, it buys EXACTLY ONE case — the one the
   * others cannot reach. A board whose frames each hold one kind is already
   * carried by frame membership; a board with no frame declares nothing
   * either way. What only the record can see is an appearance that CUTS the
   * frames — one datastore inside each of two frames — which by geometry
   * alone is `excess`, a distinction the reader looks for and does not find.
   * Naming the stencil is the document saying that distinction is real.
   *
   * A board that declares nothing — no frame, one kind — leaves every column
   * below silent. That is the blind spot, pinned rather than hidden, exactly
   * as the composition axis pins its frameless one.
   */
  readonly partitions: number
  readonly constructs: number
  /**
   * DEFICIT (ADR-0033 V1, after Moody's semiotic clarity): constructs whose
   * every member wears the DEFAULT treatment, so the drawing says nothing
   * about a distinction the document states.
   */
  readonly deficit: number
  /**
   * OVERLOAD (V2): treatments worn by two or more WHOLE constructs of one
   * partition and nothing else — the ambiguity case. A reader who learns
   * what the blue boxes are is then wrong about half of them.
   */
  readonly overload: number
  /**
   * EXCESS (V3): treatments whose wearers CUT a construct rather than
   * covering it — three of a frame's five boxes. Decoration reads as meaning
   * whether or not it was meant to, so an appearance lining up with nothing
   * is a distinction the reader looks for and does not find.
   *
   * Exclusive with `overload` by construction; see the comment at the loop
   * that decides between them for what testing them independently cost.
   */
  readonly excess: number
  /**
   * DISCRIMINABILITY (V4, Moody's visual distance): the FEWEST channels two
   * treatments in use differ on, of the TWO a board draws. `0` means fewer
   * than two distinct treatments exist — the channel says nothing at all —
   * since two distinct treatments differ on at least one by construction.
   *
   * Colour and shape together read better than either alone, most clearly at
   * 5-8 categories, and they interact (CatPAW, CHI 2026), which is why
   * spending two channels on one distinction is REPORTED as `redundancy`
   * rather than charged.
   */
  readonly distance: number
  /**
   * REPORTED ONLY, never cited for or against a change (ADR-0033).
   * `treatments` is Moody's graphic economy — how many distinct appearances
   * a reader must hold, the plain default included, so a board that spends
   * nothing reads 1. `redundancy` counts constructs drawn with more than one
   * treatment, which is a virtue or a cost depending on the task.
   */
  readonly treatments: number
  readonly redundancy: number

  /**
   * What each visual CHANNEL is doing, one level below the columns above.
   *
   * `excess` counts whole treatments — a `colour|shape` pair — so it cannot
   * say which half of one is unexplained. A board where shape carries the
   * kind cleanly and colour is spent on nothing scores the same as one where
   * both are muddled, and the two want opposite repairs.
   *
   * - `carried`: constant within every class of some declared partition, and
   *   differing across at least two of them. The channel encodes that
   *   distinction and a reader can invert it.
   * - `contested`: spent — two or more values on the board — and constant
   *   within the classes of NO declared partition. Somebody meant something
   *   by it and the document does not say what.
   * - `unused`: one value everywhere. Not a fault; a free channel.
   *
   * The case this exists for (user, 2026-09-12): an infrastructure diagram
   * wants colour for healthy-vs-failing AND shape for what a component is.
   * Two axes, two channels, each uniform within itself. Every bundled
   * stencil writes a colour as well as a silhouette, so dressing a board
   * spends the channel the second axis needs — a conflict that is invisible
   * to every column above, because with one axis declared nothing looks
   * wrong.
   */
  readonly channels: { readonly colour: ChannelReading; readonly shape: ChannelReading }
  /**
   * Scoped-tag keys that are NOT a partition of the boxes because some box
   * carries two or more values under them
   * ([ADR-0040](../../../../docs/contributing/adr/0040-scoped-tags.md)
   * decision 3), with how many boxes do. No channel can be carried by such
   * a key: colour cannot mean two things on one box, and a legend that said
   * it did would be a promise the drawing does not keep. Judged per board.
   */
  readonly multi: readonly MultiKey[]
  /**
   * The EDGES' reading, over their own population — every edge on the
   * board, the untagged ones as their own class — and judged separately
   * from the boxes: a key can partition the boxes and be `multi` on the
   * edges. One channel, the edge's colour; a second (the stroke's style) is
   * not claimed until a board shows a distinction spent on it.
   */
  readonly edges: { readonly colour: ChannelReading; readonly multi: readonly MultiKey[] }
  /** How many channels are `contested`, the edge channel included. 0 to 3. */
  readonly contested: number
}

/** @see FacetScore.multi */
export interface MultiKey {
  readonly key: string
  /** How many elements carry two or more values under the key. */
  readonly count: number
}

/** @see FacetScore.channels */
export type ChannelUse = 'carried' | 'contested' | 'unused'

/**
 * What a channel is doing, and — when it is carrying something — WHICH
 * declared distinctions it carries, by name: `frame`, `kind`, `stencil`, a
 * scoped-tag key, or the facet key of a declared axis.
 *
 * `use === 'carried'` exactly when `carriedBy` is non-empty; they are two
 * readings of one fact and a test holds them together.
 *
 * The name is what ADR-0036 recorded as missing. `carried` alone cannot
 * separate a board where colour encodes the declared STATUS axis from one
 * where a stencil's colour won and the status axis is silently undrawn —
 * identical columns, opposite repairs. That is precisely the user's case
 * (an infrastructure diagram: shape for what a component IS, colour for
 * whether it is healthy), so the instrument had to be able to see it before
 * a board could be judged on it.
 */
export interface ChannelReading {
  readonly use: ChannelUse
  readonly carriedBy: readonly string[]
}

/**
 * The channels that can say "these two differ in KIND" **on a board**.
 *
 * TWO, not three. `visual.symbol/v0` was counted here and should not have
 * been: `plugin-visual` contributes no node decoration, so a badge draws
 * NOTHING on a canvas — it was deliberately removed once the small surfaces
 * it was designed for existed (a node at full size repeated what its own
 * label already said), and the only thing that draws a node's symbol today
 * is the minimap.
 *
 * Counting it credited a distinction no reader of this canvas can see. Found
 * by rendering a board a model actually drew and noticing two stencils'
 * badges were simply absent — invisible in the SVG text, obvious in the
 * image, and invisible to every test until someone looked.
 *
 * A badge is still a real channel SOMEWHERE. If the minimap is ever scored,
 * it is scored by an instrument that knows what the minimap draws; borrowing
 * this one would make the same mistake in the other direction.
 */
interface Treatment {
  readonly colour: string
  readonly shape: string
}

const DEFAULT_TREATMENT: Treatment = { colour: '', shape: '' }
const keyOf = (t: Treatment) => `${t.colour}|${t.shape}`
const DEFAULT_KEY = keyOf(DEFAULT_TREATMENT)

/**
 * Read through `plugin-visual`'s own resolver rather than the stored bucket:
 * it is the one read path for what a node draws, compat chain and schema
 * included, so an unresolvable payload means here exactly what it means at
 * draw time — no silhouette, and the default rect.
 */
function treatmentOf(node: SpatialNode): Treatment {
  return { colour: node.color ?? '', shape: resolveNodeShape(node) ?? '' }
}

const channelsApart = (a: Treatment, b: Treatment): number =>
  (a.colour === b.colour ? 0 : 1) + (a.shape === b.shape ? 0 : 1)

type Rect = { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
const rectOf = (n: SpatialNode): Rect => ({ x: n.x, y: n.y, w: n.width, h: n.height })
const contains = (outer: Rect, inner: Rect): boolean =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.w <= outer.x + outer.w &&
  inner.y + inner.h <= outer.y + outer.h

/**
 * A partition is a map from a box's id to the class it is in. Only one with
 * two or more non-empty classes says anything, so a single-class map is
 * dropped: a board where every box is in one frame declares no distinction
 * BY that frame, whatever else the frame is doing.
 */
type Partition = ReadonlyMap<string, string>

/**
 * A partition and the NAME of the distinction it states — `frame`, `kind`,
 * `stencil`, or the facet key of a declared axis.
 *
 * The name exists so `channels` can say which axis carries a channel. Without
 * it, a board where colour encodes a declared status axis and one where a
 * stencil's colour won read identically as `carried`, and they want opposite
 * repairs (ADR-0036's recorded blind spot).
 */
interface NamedPartition {
  readonly name: string
  readonly partition: Partition
}

function declaredPartitions(
  canvas: SpatialCanvas,
  boxes: readonly SpatialNode[],
): NamedPartition[] {
  const out: NamedPartition[] = []
  const frames = canvas.nodes.filter((n) => n.type === 'group')
  if (frames.length > 0) {
    const byFrame = new Map<string, string>()
    for (const box of boxes) {
      const frame = frames.find((f) => contains(rectOf(f), rectOf(box)))
      byFrame.set(box.id, frame?.id ?? '')
    }
    out.push({ name: 'frame', partition: byFrame })
  }
  const byKind = new Map<string, string>(boxes.map((b) => [b.id, b.type]))
  out.push({ name: 'kind', partition: byKind })
  // A box wearing no stencil is its own class (''), exactly as a box in no
  // frame is: "undressed" is a thing the board says about it, not an absence
  // to be excluded — dropping those boxes would let a half-dressed board
  // read as fully carried.
  const byStencil = new Map<string, string>(boxes.map((b) => [b.id, resolveNodeStencil(b) ?? '']))
  out.push({ name: 'stencil', partition: byStencil })
  // A scoped-tag key is an axis BY CONSTRUCTION, on ADR-0036 §1's own
  // criterion: `health:failing` says what a box IS on a named dimension,
  // which is exactly what a stencil says and why `stencil` is known here by
  // name. So a board coloured by a key owes nothing and declares nothing —
  // the reading `semantic.class/v0` had before ADR-0040 retired it. The
  // `multi` half is reported by `scoreFacets`, since a key one box carries
  // twice partitions nothing.
  out.push(...tagPartitions(boxes, (b) => b.tags).partitions)
  for (const key of declaredAxisKeys(canvas)) {
    // Named by the facet KEY, which is what the canvas itself wrote — so a
    // reading points at the declaration rather than at a position in a list.
    out.push({ name: key, partition: new Map(boxes.map((b) => [b.id, facetPayloadKeyOf(b, key)])) })
  }
  return out.filter((p) => new Set(p.partition.values()).size >= 2)
}

/**
 * The facet keys a canvas names as its own semantic axes.
 *
 * Three partitions are known by name above — frame, node kind, stencil — and
 * everything else a document says about its boxes was invisible, so a colour
 * spent on it scored `contested`: a distinction the reader sees and the
 * document does not state. It did state it; this could not hear it.
 *
 * Deliberately a DECLARATION rather than "every facet is an axis".
 * `visual.shape/v0` is a facet and is not a construct — it says what a box
 * DRAWS, not what it IS — and nothing about a facet's shape reveals which it
 * is. Only the document knows, so the document says.
 *
 * Read defensively: this runs over stored content, and a payload written by
 * another version must cost the axis, never the score.
 *
 * DISTINCT, because the schema does not require it to be. `visualAxesFacetSchema`
 * validates the shape of each key and says nothing about repeats, so a
 * document may legitimately name one twice — and the same partition pushed
 * twice is scored twice, doubling `partitions`, `constructs` and whichever of
 * `deficit`/`redundancy` it contributes. Measured on a board declaring one
 * axis twice: `partitions` 1 -> 2, `constructs` 2 -> 4. Deduplicated here
 * rather than refused at the write, for the same reason the rest of this
 * function is defensive: a stored payload is data, and a repeat should cost
 * the reader nothing rather than cost the document its whole declaration.
 */
function declaredAxisKeys(canvas: SpatialCanvas): readonly string[] {
  const declared = canvas.facets?.[VISUAL_AXES_KEY]
  if (declared === null || typeof declared !== 'object') return []
  const axes = (declared as { axes?: unknown }).axes
  if (!Array.isArray(axes)) return []
  return [...new Set(axes.filter((key): key is string => typeof key === 'string'))]
}

/**
 * A box's class under one axis: a stable key for that facet's payload.
 *
 * A box that does not carry the facet keys as `null` through the same
 * function, and that is a class like any other — "unmarked" is something the
 * board says about a box, exactly as "in no frame" is. Dropping those boxes
 * would let a half-declared board read as fully carried.
 *
 * No special case for the absent payload: `facetPayloadKey` already answers
 * a stable key distinct from every real one. Writing one anyway survived a
 * mutation check, because `''` and `'null'` partition identically — an inert
 * branch reads exactly like a branch that decides something.
 */
function facetPayloadKeyOf(node: SpatialNode, key: string): string {
  return facetPayloadKey(node.facets?.[key])
}

/**
 * The scoped-tag keys of a population, split into the ones that partition it
 * and the ones that do not (ADR-0040 decision 3).
 *
 * A key K partitions when every element carries AT MOST one value under it;
 * an element carrying none is the `''` class, the way a box in no frame is,
 * so a half-classified board still reads and is not silently narrowed to
 * the elements somebody got round to. When any element carries two or more
 * values, K is `multi` with the count of such elements and partitions
 * nothing. Plain tags have no key and are never a partition; the board's own
 * tags are one object's and are not one either.
 *
 * Named by the KEY, which is what the element itself wrote — so a reading
 * points at the tag a person can see rather than at a position in a list.
 * A key cannot collide with the three built-in names or a facet key: the
 * identifier grammar admits no `.` or `/`, and `frame`, `kind` and
 * `stencil` are refused below rather than left to luck.
 */
function tagPartitions<T extends { readonly id: string }>(
  elements: readonly T[],
  tagsOf: (element: T) => readonly string[] | undefined,
): { partitions: NamedPartition[]; multi: MultiKey[] } {
  const values = new Map<string, Map<string, string[]>>()
  for (const element of elements) {
    for (const tag of tagsOf(element) ?? []) {
      const scoped = parseScopedTag(tag)
      if (scoped === undefined || BUILT_IN_PARTITIONS.has(scoped.key)) continue
      const perElement = values.get(scoped.key) ?? new Map<string, string[]>()
      perElement.set(element.id, [...(perElement.get(element.id) ?? []), scoped.value])
      values.set(scoped.key, perElement)
    }
  }
  const partitions: NamedPartition[] = []
  const multi: MultiKey[] = []
  for (const [key, perElement] of [...values].sort(([a], [b]) => a.localeCompare(b))) {
    const count = [...perElement.values()].filter((list) => list.length >= 2).length
    if (count > 0) {
      multi.push({ key, count })
      continue
    }
    partitions.push({
      name: key,
      partition: new Map(elements.map((e) => [e.id, perElement.get(e.id)?.[0] ?? ''])),
    })
  }
  return { partitions, multi }
}

const BUILT_IN_PARTITIONS: ReadonlySet<string> = new Set(['frame', 'kind', 'stencil'])

const classesOf = (partition: Partition): Map<string, string[]> => {
  const classes = new Map<string, string[]>()
  for (const [id, cls] of partition) classes.set(cls, [...(classes.get(cls) ?? []), id])
  return classes
}

/**
 * Whether one channel encodes one of the declared distinctions.
 *
 * Two conditions, and only one of them needs testing. A channel carries a
 * partition when it is CONSTANT WITHIN every class and DIFFERS across at
 * least two of them — but every partition covers every box, so a channel
 * constant within each class and equal across them holds one value
 * board-wide and has already returned `unused` above. The second condition
 * is therefore implied, and was written out here until a mutation check
 * survived removing it: an unreachable branch reads exactly like a branch
 * that decides something.
 */
function channelUse(
  channelOf: (id: string) => string,
  ids: readonly string[],
  partitions: readonly NamedPartition[],
): ChannelReading {
  // One value everywhere is not a distinction, and checking it first is what
  // makes the second condition above implicit.
  if (new Set(ids.map(channelOf)).size <= 1) {
    return { use: 'unused', carriedBy: [] }
  }
  // EVERY partition it is constant within, not the first. A channel can
  // genuinely be constant within the classes of more than one declared
  // distinction — a board whose stencils and whose declared axis happen to
  // agree — and naming one of them arbitrarily would be the same
  // over-claiming this field exists to end.
  const carriedBy = partitions
    .filter(({ partition }) => {
      const perClass = new Map<string, Set<string>>()
      for (const [id, cls] of partition) {
        perClass.set(cls, (perClass.get(cls) ?? new Set<string>()).add(channelOf(id)))
      }
      return [...perClass.values()].every((seen) => seen.size === 1)
    })
    .map(({ name }) => name)
  return carriedBy.length > 0 ? { use: 'carried', carriedBy } : { use: 'contested', carriedBy: [] }
}

export function scoreFacets(canvas: SpatialCanvas): FacetScore {
  const boxes = canvas.nodes.filter((n) => n.type !== 'group')
  const treatment = new Map(boxes.map((b) => [b.id, treatmentOf(b)]))
  const key = (id: string) => keyOf(treatment.get(id) ?? DEFAULT_TREATMENT)

  const partitions = declaredPartitions(canvas, boxes)
  const allClasses = partitions.flatMap((p) => [...classesOf(p.partition).values()])

  let deficit = 0
  let redundancy = 0
  for (const members of allClasses) {
    const keys = new Set(members.map(key))
    if (keys.size === 1 && keys.has(DEFAULT_KEY)) deficit++
    if (keys.size >= 2) redundancy++
  }

  // Who wears each SPENT treatment. The default is not a symbol a reader was
  // given — it is the absence of one — so it can be neither overloaded nor
  // in excess; a construct wearing only it is `deficit`, above.
  const wearers = new Map<string, Set<string>>()
  for (const box of boxes) {
    const k = key(box.id)
    if (k === DEFAULT_KEY) continue
    wearers.set(k, (wearers.get(k) ?? new Set<string>()).add(box.id))
  }

  // The three cases are exclusive, which is what keeps a planted defect in
  // one column: a treatment worn INSIDE one class carries that construct; one
  // worn by whole classes and nothing else carries several, which is
  // overload; and one that CUTS a class corresponds to no construct at all,
  // which is excess. Written as a partition of the cases rather than as two
  // independent tests, because the first version tested them independently
  // and charged the same board both.
  let overload = 0
  let excess = 0
  for (const [, worn] of wearers) {
    const insideSomeClass = allClasses.some((members) => {
      const set = new Set(members)
      return [...worn].every((id) => set.has(id))
    })
    if (insideSomeClass) continue
    const isWholeClasses = partitions.some((p) =>
      [...classesOf(p.partition).values()].every((members) => {
        const held = members.filter((id) => worn.has(id)).length
        return held === 0 || held === members.length
      }),
    )
    if (isWholeClasses) overload++
    else excess++
  }

  const inUse = [...new Set(boxes.map((b) => key(b.id)))].map((k) => {
    const [colour = '', shape = ''] = k.split('|')
    return { colour, shape }
  })
  let distance = 0
  if (inUse.length >= 2) {
    distance = Number.POSITIVE_INFINITY
    for (let i = 0; i < inUse.length; i++) {
      for (let j = i + 1; j < inUse.length; j++) {
        distance = Math.min(distance, channelsApart(inUse[i] as Treatment, inUse[j] as Treatment))
      }
    }
  }

  const ids = boxes.map((b) => b.id)
  const of = (read: (t: Treatment) => string) => (id: string) =>
    read(treatment.get(id) ?? DEFAULT_TREATMENT)
  const channels = {
    colour: channelUse(
      of((t) => t.colour),
      ids,
      partitions,
    ),
    shape: channelUse(
      of((t) => t.shape),
      ids,
      partitions,
    ),
  } as const

  // The edges, over their own population. Only a tag key can partition them
  // — an edge has no frame, kind or stencil — and only their colour is read.
  const edgeTags = tagPartitions(canvas.edges, (e: CanvasEdge) => e.tags)
  const edgeColour = new Map(canvas.edges.map((e) => [e.id, e.color ?? '']))
  const edges = {
    colour: channelUse(
      (id) => edgeColour.get(id) ?? '',
      canvas.edges.map((e) => e.id),
      edgeTags.partitions.filter((p) => new Set(p.partition.values()).size >= 2),
    ),
    multi: edgeTags.multi,
  } as const

  return {
    channels,
    multi: tagPartitions(boxes, (b) => b.tags).multi,
    edges,
    contested: [...Object.values(channels), edges.colour].filter((r) => r.use === 'contested')
      .length,
    partitions: partitions.length,
    constructs: allClasses.length,
    deficit,
    overload,
    excess,
    distance: Number.isFinite(distance) ? distance : 0,
    treatments: inUse.length,
    redundancy,
  }
}
