/**
 * The composition axis of [ADR-0032](../../../../docs/contributing/adr/0032-composition-axis.md):
 * what a drawing hands its reader, scored BESIDE the drawing score and
 * never mixed into it.
 *
 * The drawing score judges DEFECTS and their price. Its debt criterion
 * saturated, and the questions that remain — should a hub sit between the
 * boxes it fans out to, should every frame's first column sit on one line —
 * are not defect questions. This is the currency for those.
 *
 * **What it measures, and what it does not.** It measures the composition a
 * drawing hands its reader. It does NOT measure whether the drawing was
 * understood. Its sources are honest about the same distinction: Ngo et
 * al.'s measures (Information Sciences, 2003) are validated against
 * PERCEIVED aesthetics, SLC's visual cohesion against usability, and the
 * Gestalt work against perceptual grouping — none of them on this product's
 * drawings. A session may say a change hands the reader a more composed
 * drawing, by these columns. It may not say the drawing is easier to
 * understand on the strength of these numbers.
 *
 * One column per principle of *The Non-Designer's Design Book*, each with
 * its source; `contrast` is REPORTED-ONLY and may not be cited for or
 * against a change (ADR-0032 C4: salience manipulations have shown no
 * effect in some empirical work, and a leg that weak does not carry
 * weight).
 */
import type { SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import type { Scene } from '../scene-graph.js'

export interface CompositionScore {
  /**
   * PROXIMITY (ADR-0032 C1, after the Gestalt-in-diagrams work: a reader
   * groups by proximity whether the author meant it or not).
   *
   * A drawing declares a group by drawing a FRAME around boxes. Per group, the widest
   * gap a member keeps from its nearest fellow, against the narrowest gap
   * any member keeps from a non-member. `apart` counts the groups where the
   * inside gap is not the smaller one — spacing that contradicts the
   * grouping. `worstRatio` is the worst of those inside/outside ratios, so
   * a board can be read as well as counted: at or above 1 is a contradiction.
   */
  readonly groups: number
  readonly apart: number
  readonly worstRatio: number
  /**
   * ALIGNMENT (ADR-0032 C2, after Balinsky, Wiley & Roberts, ACM DocEng
   * 2009: alignment statistics and grid regularity).
   *
   * The guide lines a drawing resolves to — an x or y that two or more
   * elements share on one of their six anchors (left/centre/right,
   * top/middle/bottom), read to the half pixel. Distinct from the drawing
   * score's `nearMisses`, which prices a MISS: eleven boxes on four lines
   * read as composed and the same eleven on nine do not, with no near miss
   * either way.
   *
   * `guides` ALONE is ambiguous and must not be read as a verdict — a
   * scattered board shares almost no anchors and so has few lines, exactly
   * as a composed board resolving to a handful does. The pair that is
   * monotone is `offGuide`, the elements sharing no line with anything
   * (lower is better), and `perGuide`, the average number of distinct
   * elements a shared line holds (higher is better).
   */
  readonly guides: number
  readonly offGuide: number
  readonly perGuide: number
  /**
   * REPETITION (ADR-0032 C3, after Ngo et al.'s regularity, homogeneity and
   * rhythm). How much of its own vocabulary a drawing reuses: the distinct
   * box widths, heights and neighbour gaps it uses, to the grid step. Fewer
   * for the same board is more repetition.
   */
  readonly widths: number
  readonly heights: number
  readonly gaps: number
  /**
   * CONTRAST (ADR-0032 C4) — REPORTED ONLY, never owed and never cited.
   * The visual treatments a drawing spends (distinct fill + stroke pairs)
   * against the structural roles it actually has (a source, a sink, a hub
   * of three or more edges, an unconnected box). A drawing with four roles
   * and one treatment has spent nothing on telling them apart; one with two
   * roles and five treatments has spent it on something else.
   */
  readonly treatments: number
  readonly roles: number
}

type Rect = { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
const rectOf = (n: SpatialNode): Rect => ({ x: n.x, y: n.y, w: n.width, h: n.height })

/** One grid step: two measurements within it read as the same measurement. */
const SAME_PX = 8
/** Anchors are compared to the half pixel — two boxes of different parity cannot share a centre on whole pixels. */
const ANCHOR_TOLERANCE_PX = 0.5

/**
 * The clear space between two boxes: 0 when they touch or overlap, else the
 * larger of the horizontal and vertical clearances — the gap a reader sees,
 * rather than a centre-to-centre distance that shrinks as boxes get wider.
 */
function gapBetween(a: Rect, b: Rect): number {
  const dx = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w), 0)
  const dy = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h), 0)
  return Math.max(dx, dy)
}

const nearestGap = (from: Rect, others: readonly Rect[]): number =>
  others.reduce((best, other) => Math.min(best, gapBetween(from, other)), Number.POSITIVE_INFINITY)

const contains = (outer: Rect, inner: Rect): boolean =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.w <= outer.x + outer.w &&
  inner.y + inner.h <= outer.y + outer.h

/**
 * The groups a drawing DECLARES — a FRAME and the boxes it holds, and
 * nothing else.
 *
 * An edge component was in this set for one measurement and taken out by
 * it: the hand-drawn SEQUENCE reference owed all three of its groups, at a
 * worst ratio of 5.5. A message box joined to a participant column at the
 * far side of the board is not badly spaced — that spread IS the diagram's
 * grammar — so the column was charging a reference for reading correctly,
 * which the calibration forbids. Connectivity says what is related;
 * a frame is the only thing on a JSON Canvas that says "these belong
 * together, as a set", which is the claim spacing can contradict.
 *
 * The cost is that a board with no frame declares nothing and the column is
 * silent on it. Pinned as the blind spot rather than papered over.
 */
function declaredGroups(canvas: SpatialCanvas, boxes: readonly SpatialNode[]): SpatialNode[][] {
  const out: SpatialNode[][] = []
  for (const frame of canvas.nodes) {
    if (frame.type !== 'group') continue
    const members = boxes.filter((b) => contains(rectOf(frame), rectOf(b)))
    if (members.length >= 2 && members.length < boxes.length) out.push(members)
  }
  return out
}

const round2 = (n: number) => Math.round(n * 100) / 100

/** Distinct values to `SAME_PX`, counted by their rounded bucket. */
const distinct = (values: readonly number[]): number =>
  new Set(values.map((v) => Math.round(v / SAME_PX))).size

export function scoreComposition(canvas: SpatialCanvas, scene: Scene): CompositionScore {
  const nodes = canvas.nodes
  const boxes = nodes.filter((n) => n.type !== 'group')

  // C1 — proximity.
  const groups = declaredGroups(canvas, boxes)
  let apart = 0
  let worstRatio = 0
  for (const members of groups) {
    const outsiders = boxes.filter((b) => !members.some((m) => m.id === b.id)).map(rectOf)
    if (outsiders.length === 0) continue
    let inside = 0
    let outside = Number.POSITIVE_INFINITY
    for (const member of members) {
      const rect = rectOf(member)
      const fellows = members.filter((m) => m.id !== member.id).map(rectOf)
      inside = Math.max(inside, nearestGap(rect, fellows))
      outside = Math.min(outside, nearestGap(rect, outsiders))
    }
    // An outside gap of zero means a non-member is touching the group; the
    // ratio is unbounded, and the group is as contradicted as it gets.
    const ratio = outside === 0 ? Number.POSITIVE_INFINITY : inside / outside
    if (ratio >= 1) apart++
    worstRatio = Math.max(worstRatio, Number.isFinite(ratio) ? ratio : 999)
  }

  // C2 — alignment.
  const anchorsOf = (r: Rect) => ({
    x: [r.x, r.x + r.w / 2, r.x + r.w],
    y: [r.y, r.y + r.h / 2, r.y + r.h],
  })
  const lineKey = (v: number) => Math.round(v / ANCHOR_TOLERANCE_PX)
  const sharedOn = (axis: 'x' | 'y'): Map<number, Set<string>> => {
    const holders = new Map<number, Set<string>>()
    for (const node of nodes) {
      for (const value of anchorsOf(rectOf(node))[axis]) {
        const key = lineKey(value)
        holders.set(key, (holders.get(key) ?? new Set<string>()).add(node.id))
      }
    }
    return holders
  }
  const onX = sharedOn('x')
  const onY = sharedOn('y')
  const shared = [...onX.values(), ...onY.values()].filter((ids) => ids.size >= 2)
  const guides = shared.length
  const held = new Set(shared.flatMap((ids) => [...ids]))
  const offGuide = nodes.filter((n) => !held.has(n.id)).length

  // C3 — repetition.
  const boxRects = boxes.map(rectOf)
  const gapValues = boxRects.map((rect, i) =>
    nearestGap(
      rect,
      boxRects.filter((_, j) => j !== i),
    ),
  )

  // C4 — contrast, reported only.
  const treatments = new Set<string>()
  for (const shape of scene.nodes) {
    if (shape.kind !== 'shape') continue
    treatments.add(`${shape.appearance?.fill ?? ''}|${shape.appearance?.stroke ?? ''}`)
  }
  const degree = new Map<string, { out: number; in: number }>()
  for (const box of boxes) degree.set(box.id, { out: 0, in: 0 })
  for (const edge of canvas.edges) {
    const from = degree.get(edge.fromNode)
    const to = degree.get(edge.toNode)
    if (from !== undefined) from.out++
    if (to !== undefined) to.in++
  }
  const roleOf = (d: { out: number; in: number }): string => {
    if (d.out + d.in === 0) return 'alone'
    if (d.out + d.in >= 3) return 'hub'
    if (d.in === 0) return 'source'
    if (d.out === 0) return 'sink'
    return 'through'
  }
  const roles = new Set([...degree.values()].map(roleOf))

  return {
    groups: groups.length,
    apart,
    worstRatio: Number.isFinite(worstRatio) ? round2(worstRatio) : 999,
    guides,
    offGuide,
    perGuide: guides === 0 ? 0 : round2(shared.reduce((sum, ids) => sum + ids.size, 0) / guides),
    widths: distinct(boxRects.map((r) => r.w)),
    heights: distinct(boxRects.map((r) => r.h)),
    gaps: distinct(gapValues.filter(Number.isFinite)),
    treatments: treatments.size,
    roles: roles.size,
  }
}
