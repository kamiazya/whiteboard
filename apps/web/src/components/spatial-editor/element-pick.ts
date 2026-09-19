/**
 * Which KIND of element a press or a band lands on.
 *
 * This module exists because of how a whole session's defects arrived, all
 * of them the same shape. `lines` were added to the model and the editor
 * learned about them one surface at a time: the press hit-test settled on
 * the node under the stroke, the band looked at boxes only, and shift
 * dropped the selection it was meant to grow. Every one passed every suite,
 * because nothing anywhere was written in terms of "every kind a canvas
 * holds" — each surface named the kinds it happened to know about, and a
 * kind nobody named was simply absent.
 *
 * So the answer is not another list. `ElementCollection` is DERIVED from
 * `SpatialCanvas`, and `ELEMENT_PICK_ROLE` is `satisfies Record<...>` over
 * it — in production code, not in a test. Adding a collection to the model
 * stops `tsc`, and the thing it stops is the editor's own build rather than
 * a guard somebody can decide to skip.
 *
 * What it cannot do by itself is prove a kind the table CALLS contended for
 * is really reachable; a probe can be wired to a stale list and answer
 * nothing for ever. That half is `element-pick.property.test.ts`, which
 * drives these functions over generated canvases and tallies which kinds
 * the run actually produced.
 */
import type { CanvasLine, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { distanceToPolyline, hitTest, type NodeBox } from '../../lib/spatial/geometry.js'
import type { Point } from '../../lib/spatial/viewport.js'
import { type DrawnPath, inkUnder, inkWithin, type Rect } from './ink-hit.js'

/**
 * Every collection of identified elements a canvas holds.
 *
 * Derived rather than written down, so it cannot go stale. `facets` and
 * `tags` are records rather than arrays of things with ids, so they are not
 * element kinds and do not appear.
 */
export type ElementCollection = {
  [K in keyof SpatialCanvas]-?: NonNullable<SpatialCanvas[K]> extends readonly {
    readonly id: string
  }[]
    ? K
    : never
}[keyof SpatialCanvas]

/**
 * What a kind IS to a pointer, which is a different question from what it is
 * to the document.
 *
 * `content` is what a press and a band contend for — the stuff a selection
 * holds and a verb acts on. `chrome` floats above the document and takes its
 * own press before content is considered (an annotation's pin), so it is not
 * in the contention at all and must not be, or a press on a note under a
 * comment pin would stop answering with the note. Each non-content entry
 * owes a reason, for the same purpose `blastRadius: none:` does — a bare
 * exemption is the omission with a word in front of it.
 */
export type ElementPickRole = 'content' | `chrome: ${string}` | `n/a: ${string}`

export const ELEMENT_PICK_ROLE = {
  nodes: 'content',
  edges: 'content',
  lines: 'content',
  comments:
    'chrome: a comment is not content (ADR-0024) — its pin floats above the document and takes the press before content is contended for, so putting it in this order would make a note under a pin unpressable',
} satisfies Record<ElementCollection, ElementPickRole>

/** The kinds a press and a band contend for, narrowed from the table above. */
export type ContentKind = {
  [K in ElementCollection]: (typeof ELEMENT_PICK_ROLE)[K] extends 'content' ? K : never
}[ElementCollection]

/**
 * Priority order, highest first — the one statement of which kind wins when
 * two lie under the same point.
 *
 * Ink first: a stroke is drawn ON what it crosses, the way it would be on
 * paper, so a press on it means the stroke and not the note underneath.
 * Edges last: an edge is a relation whose path is ROUTED around the boxes it
 * connects, so letting it beat a node would lay a dead band across something
 * somebody is trying to press, in exchange for a case the router avoids.
 *
 * It was three `if`s two hundred lines apart before this, and the order was
 * a property of where each one had been written.
 */
export const CONTENT_PICK_ORDER = [
  'lines',
  'nodes',
  'edges',
] as const satisfies readonly ContentKind[]

/**
 * A probe a surface deliberately does not run, and why.
 *
 * The alternative is a probe that answers nothing, which reads identically
 * to a probe that is broken and identically to a kind nobody thought about
 * — the failure this whole module is against. A skip is a sentence in the
 * source at the call site, where the person adding a kind is already
 * looking.
 */
export interface SkippedProbe {
  readonly skipped: string
}

export type PointProbe = (point: Point) => string | undefined
export type BandProbe = (rect: Rect) => readonly string[]

const isSkipped = (probe: unknown): probe is SkippedProbe =>
  typeof probe === 'object' && probe !== null && 'skipped' in probe

export interface ContentPick {
  readonly kind: ContentKind
  readonly id: string
}

/**
 * The element a press at `point` lands on, or `undefined` for empty board.
 *
 * Every probe is the caller's: this module owns the ORDER and the totality,
 * never the geometry. A locked element is the caller's business too — it
 * filters in its own probe, which is what keeps a lock out of the selection,
 * out of Delete and out of the label editor at one point instead of at each.
 */
export function pickContentAt(
  probes: Record<ContentKind, PointProbe | SkippedProbe>,
  point: Point,
): ContentPick | undefined {
  for (const kind of CONTENT_PICK_ORDER) {
    const probe = probes[kind]
    if (isSkipped(probe)) continue
    const id = probe(point)
    if (id !== undefined) return { kind, id }
  }
  return undefined
}

/**
 * Everything a band gathers, per kind.
 *
 * Answers for every content kind, so a kind a band does not take is a
 * `SkippedProbe` carrying its reason rather than an absence. `edges` is one
 * today: an edge follows the nodes it connects, so a band over a diagram
 * arguably means the nodes AND their relations — but that is a product
 * decision nobody has taken, and taking it here would be taking it by
 * accident.
 */
export function pickContentWithin(
  probes: Record<ContentKind, BandProbe | SkippedProbe>,
  rect: Rect,
): Record<ContentKind, readonly string[]> {
  const answer = {} as Record<ContentKind, readonly string[]>
  for (const kind of CONTENT_PICK_ORDER) {
    const probe = probes[kind]
    answer[kind] = isSkipped(probe) ? [] : probe(rect)
  }
  return answer
}

/**
 * What a surface knows about the board, which is the only thing it supplies.
 *
 * The editor hands over DATA and this module owns the decision — both the
 * order and which probe each kind gets. The probes lived at the call sites
 * before, which meant the property that judges them could only judge a COPY
 * of them: a test that rebuilds a probe passes over an editor that never
 * calls it. One definition, two readers, and neither can drift.
 */
export interface PickInputs {
  /** Every drawn path the scene laid out, edges and ink alike. */
  readonly paths: readonly DrawnPath[]
  /** EVERY box the scene laid out; the probes drop the locked ones themselves. */
  readonly boxes: readonly NodeBox[]
  /** How near counts as "on a path", in CANVAS units (the caller divides by zoom). */
  readonly tolerance: number
  /**
   * The two locks, asked the same way.
   *
   * They used to be asked differently — a path's lock was a predicate the
   * probe applied, while a node's was applied by the CALLER, which handed
   * over a box list with the locked ones already gone. Same rule, two
   * shapes, and the difference was invisible: a surface reading one of them
   * had no reason to think the other worked another way. A caller that
   * wants locked things pickable anyway — the context menu, so Unlock stays
   * reachable — now says so once per kind instead of swapping a list for
   * one and passing a predicate for the other.
   */
  readonly isNodeLocked: (id: string) => boolean
  readonly isEdgeLocked: (id: string) => boolean
}

/**
 * The boxes a pointer may target: a locked node is invisible to it.
 *
 * Exported because the pick is not the only reader — the connect gesture,
 * its overlay and the drag preview all need the same list — but it is the
 * one place the rule is written. Filtering the LIST rather than rejecting
 * the answer is load-bearing: `hitTest` answers the topmost box, so a
 * locked node lying over an unlocked one must not swallow the press.
 */
export function pointableBoxes(
  boxes: readonly NodeBox[],
  isNodeLocked: (id: string) => boolean,
): readonly NodeBox[] {
  const pointable = boxes.filter((entry) => !isNodeLocked(entry.id))
  // The same array when nothing is locked, which is the common case and
  // what keeps a `useMemo` over this from invalidating every render.
  return pointable.length === boxes.length ? boxes : pointable
}

/** The probes a PRESS contends with, in `CONTENT_PICK_ORDER`. */
export function pressProbes(inputs: PickInputs): Record<ContentKind, PointProbe | SkippedProbe> {
  return {
    lines: (at) => inkUnder(inputs.paths, at, inputs.tolerance, inputs.isEdgeLocked)?.id,
    nodes: (at) => hitTest(pointableBoxes(inputs.boxes, inputs.isNodeLocked), at),
    // Locked edges are invisible here, which is what keeps a locked edge out
    // of the selection and therefore out of Delete, the label editor
    // (double-press) and every restyle command, at one point instead of at
    // each of them.
    edges: (at) =>
      inputs.paths.find(
        (path) =>
          !inputs.isEdgeLocked(path.id) && distanceToPolyline(at, path.path) <= inputs.tolerance,
      )?.id,
  }
}

/** The probes a BAND gathers with. */
export function bandProbes(inputs: PickInputs): Record<ContentKind, BandProbe | SkippedProbe> {
  return {
    lines: (band) => inkWithin(inputs.paths, band, inputs.isEdgeLocked),
    nodes: (band) =>
      pointableBoxes(inputs.boxes, inputs.isNodeLocked)
        .filter(
          (entry) =>
            entry.box.x < band.x + band.w &&
            entry.box.x + entry.box.width > band.x &&
            entry.box.y < band.y + band.h &&
            entry.box.y + entry.box.height > band.y,
        )
        .map((entry) => entry.id),
    edges: {
      skipped:
        'an edge follows the nodes it connects, so a band over a diagram arguably means the nodes AND their relations — a product decision nobody has taken, and taking it here would be taking it by accident',
    },
  }
}

/**
 * What holding SHIFT over a picked element means, per kind.
 *
 * Shift is the surface that has broken twice, both times because the answer
 * for one kind was written where the answer for another already lived. The
 * node arm tests `hitId`, which ink deliberately leaves undefined so a
 * stroke can win a press — so for a long time shift over ink fell through
 * to the branch that REPLACES, and holding shift destroyed the selection it
 * was meant to grow. A kind whose answer is "nothing yet" says so here,
 * with its reason, instead of being the kind nobody wrote an arm for.
 */
export type ShiftPress =
  /** Toggle this node's membership; the caller owns the node selection. */
  | { readonly kind: 'nodes'; readonly id: string }
  /** The next ink selection, whole marks in and whole marks out. */
  | { readonly kind: 'lines'; readonly ids: readonly string[] }
  /** Shift does nothing for this kind, and says why. */
  | { readonly kind: 'none'; readonly because: string }

export function shiftPress(
  pick: ContentPick | undefined,
  heldInkIds: readonly string[],
  lines: readonly CanvasLine[] | undefined,
  /**
   * `withGroupMates`, passed in rather than imported: this module owns the
   * per-kind decisions and `ink-hit.ts` owns what a mark is.
   */
  groupMates: (
    ids: readonly string[],
    lines: readonly CanvasLine[] | undefined,
  ) => readonly string[],
): ShiftPress {
  if (pick === undefined) return { kind: 'none', because: 'the press landed on empty board' }
  if (pick.kind === 'nodes') return { kind: 'nodes', id: pick.id }
  if (pick.kind === 'lines') {
    // The whole MARK: a handwritten character is several strokes carrying
    // one group id, and a person pressing one of them means the character.
    const mark = groupMates([pick.id], lines)
    const held = new Set(heldInkIds)
    // A mark already held is REMOVED, which is what shift means everywhere
    // else in this editor: a press on a member toggles it.
    const whole = mark.every((id) => held.has(id))
    return {
      kind: 'lines',
      ids: whole
        ? heldInkIds.filter((id) => !mark.includes(id))
        : [...new Set([...heldInkIds, ...mark])],
    }
  }
  return {
    kind: 'none',
    because:
      "shift never adds an EDGE, in either direction — it also drops a held edge when a node is shift-pressed. What separates an edge from ink here is the verbs behind the selection: a stroke's (Delete, Ungroup) already act on a set, while an edge's dispatch to a single target, so `toggle-lock` would lock a surviving relation instead of the nodes being gathered. Opening it means giving those verbs a set, which is a product decision nobody has asked for",
  }
}
