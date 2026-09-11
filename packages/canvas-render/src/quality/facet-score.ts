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
import type { SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import {
  resolveNodeShape,
  resolveNodeStencil,
  resolveNodeSymbol,
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
   * treatments in use differ on, of the three there are. `0` means fewer
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
}

/** The three channels that can say "these two differ in KIND". */
interface Treatment {
  readonly colour: string
  readonly shape: string
  readonly badge: string
}

const DEFAULT_TREATMENT: Treatment = { colour: '', shape: '', badge: '' }
const keyOf = (t: Treatment) => `${t.colour}|${t.shape}|${t.badge}`
const DEFAULT_KEY = keyOf(DEFAULT_TREATMENT)

/**
 * Read through `plugin-visual`'s own resolvers rather than the stored bucket:
 * they are the one read path for what a node draws, compat chain and schema
 * included, so an unresolvable payload means here exactly what it means at
 * draw time — no badge, no silhouette.
 */
function treatmentOf(node: SpatialNode): Treatment {
  const symbol = resolveNodeSymbol(node)
  return {
    colour: node.color ?? '',
    shape: resolveNodeShape(node) ?? '',
    badge:
      symbol === undefined
        ? ''
        : symbol.kind === 'icon'
          ? `icon:${symbol.name}`
          : `emoji:${symbol.char}`,
  }
}

const channelsApart = (a: Treatment, b: Treatment): number =>
  (a.colour === b.colour ? 0 : 1) + (a.shape === b.shape ? 0 : 1) + (a.badge === b.badge ? 0 : 1)

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

function declaredPartitions(canvas: SpatialCanvas, boxes: readonly SpatialNode[]): Partition[] {
  const out: Partition[] = []
  const frames = canvas.nodes.filter((n) => n.type === 'group')
  if (frames.length > 0) {
    const byFrame = new Map<string, string>()
    for (const box of boxes) {
      const frame = frames.find((f) => contains(rectOf(f), rectOf(box)))
      byFrame.set(box.id, frame?.id ?? '')
    }
    out.push(byFrame)
  }
  const byKind = new Map<string, string>(boxes.map((b) => [b.id, b.type]))
  out.push(byKind)
  // A box wearing no stencil is its own class (''), exactly as a box in no
  // frame is: "undressed" is a thing the board says about it, not an absence
  // to be excluded — dropping those boxes would let a half-dressed board
  // read as fully carried.
  const byStencil = new Map<string, string>(boxes.map((b) => [b.id, resolveNodeStencil(b) ?? '']))
  out.push(byStencil)
  return out.filter((p) => new Set(p.values()).size >= 2)
}

const classesOf = (partition: Partition): Map<string, string[]> => {
  const classes = new Map<string, string[]>()
  for (const [id, cls] of partition) classes.set(cls, [...(classes.get(cls) ?? []), id])
  return classes
}

export function scoreFacets(canvas: SpatialCanvas): FacetScore {
  const boxes = canvas.nodes.filter((n) => n.type !== 'group')
  const treatment = new Map(boxes.map((b) => [b.id, treatmentOf(b)]))
  const key = (id: string) => keyOf(treatment.get(id) ?? DEFAULT_TREATMENT)

  const partitions = declaredPartitions(canvas, boxes)
  const allClasses = partitions.flatMap((p) => [...classesOf(p).values()])

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
      [...classesOf(p).values()].every((members) => {
        const held = members.filter((id) => worn.has(id)).length
        return held === 0 || held === members.length
      }),
    )
    if (isWholeClasses) overload++
    else excess++
  }

  const inUse = [...new Set(boxes.map((b) => key(b.id)))].map((k) => {
    const [colour = '', shape = '', badge = ''] = k.split('|')
    return { colour, shape, badge }
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

  return {
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
