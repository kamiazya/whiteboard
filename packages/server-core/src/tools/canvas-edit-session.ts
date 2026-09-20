import {
  constantRatioMeasureText,
  type MeasureText,
  naturalNodeContentSize,
  SPATIAL_THEME_GEOMETRY,
} from '@kamiazya/whiteboard-canvas-render'
import { readEdgeLocks, readNodeLocks } from '@kamiazya/whiteboard-loro-adapter'
import {
  applyNodePatch,
  type CanvasComment,
  type CanvasEdge,
  type CanvasLine,
  endIn,
  isFrame,
  nodePatchField,
  type nodePatchFieldsSchema,
  nodeText,
  type SpatialCanvas,
  type SpatialNode,
  spatialNodeSchema,
} from '@kamiazya/whiteboard-model'
import type { LoroDoc } from 'loro-crdt'
import type { z } from 'zod'
import { MCP_SCENE_APPEARANCE } from '../render/compose-canvas-scene.js'
import { fail } from './canvas-edit-error.js'
import type { geometryEntrySchema, Target } from './canvas-edit-ops.js'
import {
  overlaps,
  PLACEMENT_GUTTER_PX,
  PlacementCursor,
  placeWithin,
  prevailingWidth,
  type Rect,
} from './canvas-edit-placement.js'
import { publishedKind } from './published-node-kind.js'

/**
 * The height a text node needs to hold its text at its width. A height is
 * derived from a width and a text, never from a position: text laid out
 * at a width wraps to a height, and a height read from a position would
 * need the position first.
 */
export function fittedHeight(node: SpatialNode, measure: MeasureText, fallback: number): number {
  // The taller of two readings: the composition root's own font, and the
  // ratio measurer every machine has. The daemon's font is narrower than
  // the ratio, so a box it fits can still read as cut to the drawing score
  // and to a client drawing with a wider font; the floor is what makes
  // "fits" mean the same thing to the tool and to what judges it.
  const under = (m: MeasureText) =>
    naturalNodeContentSize(node, { measure: m, appearance: MCP_SCENE_APPEARANCE }).h
  const natural = Math.max(under(measure), under(constantRatioMeasureText))
  return Math.max(fallback, natural + 2 * SPATIAL_THEME_GEOMETRY.paddingPx)
}

/**
 * Refuses a text node whose named height cannot hold its text at its width,
 * naming the height it needs. A named height used to be kept however small
 * — "no height" and "a small height" are different inputs — until the lane
 * read what a model does with that: it names its neighbours' size to match
 * them and the sentence is cut where nothing it can see says so. Growing
 * the box silently would put it into whatever sits below, so the number
 * goes back to the caller instead.
 */
export function assertTextFits(
  index: number,
  opName: string,
  node: SpatialNode,
  measure: MeasureText,
) {
  if (nodeText(node) === undefined) return
  // Whole pixels, as JSON Canvas sizes are; a box short by a fraction of one
  // is a box the renderer draws without a fade.
  const needs = Math.floor(fittedHeight(node, measure, 0))
  if (node.height < needs) {
    fail(
      index,
      opName,
      `its text needs ${needs}px of height at width ${node.width}; name at least that, or omit height and the box is sized to fit`,
    )
  }
}

/**
 * The in-memory canvas one `wb_canvas_edit` batch edits, and the helpers that
 * keep its invariants.
 *
 * It exists so an operation can be a FUNCTION rather than a case in a switch.
 * Every op runs against these values and nothing reaches the doc until the
 * last one has applied — that is what makes the batch all-or-nothing — so an
 * op handler needs the whole set, and a 500-line closure was the only way to
 * give it to them while the state lived in `let` bindings. Holding it on one
 * object is what let the handlers move out; the arrays stay mutable and are
 * REASSIGNED rather than spliced, exactly as before, because the ops read
 * them as snapshots within a single op.
 *
 * The helpers are arrow properties rather than methods on purpose: several
 * are passed straight to `filter`/`map` (`enclosedBy(group)` is), and a
 * method reference would arrive unbound.
 */
export class CanvasEditSession {
  nodes: SpatialNode[]
  edges: CanvasEdge[]
  lines: CanvasLine[]
  comments: CanvasComment[]
  /**
   * Read ONCE, off the board as it stood before this batch — the same
   * anchoring `PlacementCursor` does, and for the same reason: re-reading
   * it per node would have each addition chase the ones this batch is
   * adding, so on an empty board the second box would inherit the first's
   * fallback as though the board had always used it.
   */
  readonly boardWidth: number | undefined
  readonly nodeLocks: Set<string>
  readonly edgeLocks: Set<string>
  readonly touchedNodes = new Set<string>()
  readonly touchedEdges = new Set<string>()
  readonly touchedLines = new Set<string>()
  readonly touchedComments = new Set<string>()
  readonly geometry = new Map<string, z.infer<typeof geometryEntrySchema>>()
  readonly cursor = new PlacementCursor()
  /**
   * Groups this batch put at the cursor, with the sizes they were given
   * (a default is not a choice). A caller that adds a group with no
   * position and then declares its members has said where the group
   * goes: around them. Placing it at the cursor and pulling the members
   * in put a row the caller had just drawn into a column inside a
   * default box, and every model then spent two calls undoing it.
   */
  readonly placedByCursor = new Map<string, { width?: number; height?: number; placed?: true }>()
  /**
   * Undefined unless some op creates a text node or changes what decides
   * whether one's text fits — the composition root's measurer parses a font
   * on first use, and a batch of moves and locks should not pay for that.
   */
  readonly measure: MeasureText | undefined

  constructor(canvas: SpatialCanvas, doc: LoroDoc, measure: MeasureText | undefined) {
    this.nodes = [...canvas.nodes]
    this.boardWidth = prevailingWidth(canvas.nodes)
    this.edges = [...canvas.edges]
    this.lines = [...(canvas.lines ?? [])]
    this.comments = [...(canvas.comments ?? [])]
    this.nodeLocks = new Set(readNodeLocks(doc))
    this.edgeLocks = new Set(readEdgeLocks(doc))
    this.measure = measure
  }

  nodeAt = (id: string) => this.nodes.find((node) => node.id === id)
  edgeAt = (id: string) => this.edges.find((edge) => edge.id === id)
  lineAt = (id: string) => this.lines.find((line) => line.id === id)

  groupNamed = (index: number, opName: string, id: string): SpatialNode => {
    const group = this.nodeAt(id)
    if (group === undefined || !isFrame(group)) {
      fail(
        index,
        opName,
        `"${id}" is not a group on the canvas; within names one to place inside — to wrap boxes that already exist in a new group, add the group and then region.set`,
      )
    }
    return group
  }
  /** Strict containment in a group's CURRENT box, the group itself excluded. */
  enclosedBy =
    (group: SpatialNode) =>
    (node: SpatialNode): boolean =>
      node.id !== group.id &&
      node.x >= group.x &&
      node.y >= group.y &&
      node.x + node.width <= group.x + group.width &&
      node.y + node.height <= group.y + group.height
  /**
   * Grows a group so that every rect is inside it, gutter included.
   * Grow-only, only when a rect reaches past the right or bottom edge
   * less `keep` (a caller's own position is honoured to the edge; a
   * position this batch chose keeps the gutter, since flush with the
   * frame reads as jammed), and the top-left stays put, so re-applying
   * the same op stays a no-op; what it can do is enclose a neighbour
   * that sat just past the old edge, which the next region.set will
   * then see in scope — geometry is geometry, and the result reports
   * the size. A rect before the top-left is the caller's to move;
   * callers refuse it.
   */
  growToHold = (
    index: number,
    opName: string,
    group: SpatialNode,
    rects: readonly Rect[],
    keep = 0,
  ): void => {
    const bounds = this.nodeAt(group.id) ?? group
    const needed = rects.reduce(
      (acc, rect) => {
        const right = rect.x + rect.width
        const bottom = rect.y + rect.height
        return {
          width:
            right + keep > bounds.x + bounds.width
              ? Math.max(acc.width, right + PLACEMENT_GUTTER_PX - bounds.x)
              : acc.width,
          height:
            bottom + keep > bounds.y + bounds.height
              ? Math.max(acc.height, bottom + PLACEMENT_GUTTER_PX - bounds.y)
              : acc.height,
        }
      },
      { width: bounds.width, height: bounds.height },
    )
    if (needed.width <= bounds.width && needed.height <= bounds.height) return
    // Never over a neighbour. Growth that swallows a node just past the
    // old edge makes it a member the next region.set deletes by
    // omission — so a node the old box did not overlap is a wall, and
    // the refusal names it.
    const grownBox = { ...bounds, width: needed.width, height: needed.height }
    const wall = this.nodes.find(
      (node) => node.id !== bounds.id && !overlaps(node, bounds) && overlaps(node, grownBox),
    )
    if (wall !== undefined) {
      fail(
        index,
        opName,
        `"${bounds.id}" would have to grow to ${needed.width}x${needed.height} and that reaches "${wall.id}"; move "${wall.id}" or place the node elsewhere`,
      )
    }
    if (this.nodeLocks.has(bounds.id)) {
      fail(
        index,
        opName,
        `"${bounds.id}" is locked and too small for what goes in it (needs ${needed.width}x${needed.height}); unlock it, or keep each node inside it`,
      )
    }
    const grown: SpatialNode = { ...bounds, width: needed.width, height: needed.height }
    this.nodes = this.nodes.map((node) => (node.id === grown.id ? grown : node))
    this.touchedNodes.add(grown.id)
    this.geometry.set(grown.id, {
      id: grown.id,
      x: grown.x,
      y: grown.y,
      width: grown.width,
      height: grown.height,
    })
  }
  /**
   * Places sizes inside a group around what it already holds. A
   * placement is this batch's own arithmetic, so a placement that lands
   * outside is its to fix, not the caller's: the group grows.
   */
  placeInside = (
    index: number,
    opName: string,
    group: SpatialNode,
    sizes: readonly { width: number; height: number }[],
  ): { x: number; y: number }[] => {
    const bounds = this.nodeAt(group.id) ?? group
    const placements = placeWithin(bounds, sizes, this.nodes.filter(this.enclosedBy(bounds)))
    this.growToHold(
      index,
      opName,
      bounds,
      placements.map((at, i) => ({ ...at, ...(sizes[i] ?? { width: 0, height: 0 }) })),
      PLACEMENT_GUTTER_PX,
    )
    return placements
  }

  /**
   * Puts a group this batch placed at the cursor around what is put in
   * it: the rects' bounds plus the gutter, joined with the group's
   * current box when it already holds something, never smaller than a
   * size it was given. A bystander in that box would become a member
   * the next region.set deletes by omission, so it is a wall; a frame
   * the box nests inside is not.
   */
  placeAround = (
    index: number,
    opName: string,
    group: SpatialNode,
    rects: readonly SpatialNode[],
    given: { width?: number; height?: number; placed?: true },
  ): SpatialNode => {
    // The cursor's box holds nothing, whatever it happens to cover: only
    // a box already placed around members is joined with the next.
    const holding = given.placed === true
    const around = rects.map((r) => ({
      x: r.x - PLACEMENT_GUTTER_PX,
      y: r.y - PLACEMENT_GUTTER_PX,
      width: r.width + 2 * PLACEMENT_GUTTER_PX,
      height: r.height + 2 * PLACEMENT_GUTTER_PX,
    }))
    const all = holding ? [...around, group] : around
    const left = Math.min(...all.map((r) => r.x))
    const top = Math.min(...all.map((r) => r.y))
    const right = Math.max(...all.map((r) => r.x + r.width))
    const bottom = Math.max(...all.map((r) => r.y + r.height))
    const box = {
      x: left,
      y: top,
      width: Math.max(given.width ?? 0, right - left),
      height: Math.max(given.height ?? 0, bottom - top),
    }
    const members = new Set(rects.map((r) => r.id))
    // Another group this batch put at the cursor, still holding
    // nothing, is not a wall: it follows its own members when they
    // come, and until then the cursor's spot is nobody's choice.
    const unsettled = (node: SpatialNode) =>
      this.placedByCursor.has(node.id) && this.placedByCursor.get(node.id)?.placed !== true
    const wall = this.nodes.find(
      (node) =>
        node.id !== group.id &&
        !members.has(node.id) &&
        !this.enclosedBy(group)(node) &&
        !unsettled(node) &&
        overlaps(node, box) &&
        !(isFrame(node) && this.enclosedBy(node)({ ...group, ...box })),
    )
    if (wall !== undefined) {
      fail(
        index,
        opName,
        `"${group.id}" placed around its members would reach "${wall.id}"; move "${wall.id}", or give "${group.id}" a position and size`,
      )
    }
    const placed = { ...group, ...box }
    this.nodes = this.nodes.map((node) => (node.id === group.id ? placed : node))
    this.touchedNodes.add(group.id)
    this.geometry.set(group.id, { id: group.id, ...box })
    this.placedByCursor.set(group.id, { ...given, placed: true })
    return placed
  }

  /** The node ids one target selects, in canvas order; never empty. */
  nodeTargets = (index: number, opName: string, target: Target): string[] => {
    if (target.id !== undefined) {
      if (this.nodeAt(target.id) === undefined) {
        fail(index, opName, `node "${target.id}" is not on the canvas`)
      }
      return [target.id]
    }
    if (target.within !== undefined) {
      const group = this.groupNamed(index, opName, target.within)
      const ids = this.nodes.filter(this.enclosedBy(group)).map((node) => node.id)
      if (ids.length === 0) fail(index, opName, `no node is inside "${group.id}"`)
      return ids
    }
    if (this.nodes.length === 0) fail(index, opName, 'the canvas has no nodes')
    return this.nodes.map((node) => node.id)
  }
  edgeTargets = (index: number, opName: string, target: Target): string[] => {
    if (target.id !== undefined) {
      if (this.edgeAt(target.id) === undefined) {
        fail(index, opName, `edge "${target.id}" is not on the canvas`)
      }
      return [target.id]
    }
    if (target.within !== undefined) {
      const group = this.groupNamed(index, opName, target.within)
      const inside = new Set(this.nodes.filter(this.enclosedBy(group)).map((node) => node.id))
      const ids = this.edges
        .filter((edge) => endIn(edge.from, inside) && endIn(edge.to, inside))
        .map((edge) => edge.id)
      if (ids.length === 0) fail(index, opName, `no edge has both ends inside "${group.id}"`)
      return ids
    }
    if (this.edges.length === 0) fail(index, opName, 'the canvas has no edges')
    return this.edges.map((edge) => edge.id)
  }

  issues = (error: z.ZodError): string => error.issues.map((issue) => issue.message).join('; ')
  patchNode = (
    index: number,
    opName: string,
    id: string,
    patch: z.infer<typeof nodePatchFieldsSchema>,
  ): void => {
    const node = this.nodeAt(id)
    if (node === undefined) fail(index, opName, `node "${id}" is not on the canvas`)
    // A content key the TARGET has no room for. `applyNodePatch` IGNORES
    // one — it answers what the patch means, and a proposal has nobody to
    // deliver a refusal to — so the tool asks what the patch actually
    // took. Read back through the same seam rather than against a second
    // table of which key goes with which kind: a key that did not land is
    // exactly a key the node has no room for.
    //
    // Before ADR-0038 decision 3 the node schemas' strictness detected
    // this, and the message below was already written by hand because
    // "Unrecognized key" names the key and NOT the kind. Dissolving the
    // union takes the detector away, so it moves here; the message it
    // feeds is unchanged, and so is what a caller sees.
    const applied = applyNodePatch(node, patch)
    const unheld = (Object.keys(patch) as (keyof typeof patch)[]).filter(
      (key) => patch[key] !== undefined && !Object.is(nodePatchField(applied, key), patch[key]),
    )
    if (unheld.length > 0) {
      fail(
        index,
        opName,
        `a ${publishedKind(node)} node has no ${unheld.join(', ')} — the patch would have been ` +
          'accepted and silently dropped, so it is refused instead',
      )
    }
    const parsed = spatialNodeSchema.safeParse(applied)
    if (!parsed.success) {
      // A patch key the TARGET's type does not have. `label` on a text
      // node is the case that exists today: it is on the patch allowlist
      // because a GROUP has one, so the key is known to the union and
      // wrong for this member.
      //
      // Before ADR-0037 the node schemas were non-strict, the re-parse
      // stripped such a key, and this was a hand-written diff of the keys
      // that survived. Strictness detects it exhaustively now — but it
      // reports "Unrecognized key", which names the key and NOT the type,
      // and a caller told only `label` is invalid is left guessing which
      // of its nodes was wrong. So strictness is the detector and the
      // message is still written here.
      const unknown = parsed.error.issues.flatMap((issue) =>
        issue.code === 'unrecognized_keys' ? issue.keys : [],
      )
      if (unknown.length > 0) {
        fail(
          index,
          opName,
          `a ${publishedKind(node)} node has no ${unknown.join(', ')} — the patch would have been ` +
            'accepted and silently dropped, so it is refused instead',
        )
      }
      fail(index, opName, this.issues(parsed.error))
    }
    const updated = parsed.data
    if (
      this.measure !== undefined &&
      (patch.text !== undefined || patch.width !== undefined || patch.height !== undefined)
    ) {
      assertTextFits(index, opName, updated, this.measure)
    }
    this.nodes = this.nodes.map((existing) => (existing.id === id ? updated : existing))
    this.touchedNodes.add(id)
  }
}
