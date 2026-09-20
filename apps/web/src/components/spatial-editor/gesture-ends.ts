/**
 * The end-drag's own half of the reducer: what a re-attachment remembers,
 * and what its release writes.
 *
 * Its own module for `gesture-bends.ts`'s reason — the cluster shares
 * nothing with the rest of the machine, and `gestures.ts` is at its budget.
 *
 * The asymmetry this file exists to hold: the same drag over the same
 * pixels ends two ways depending on which collection the element came from.
 * A stroke's end may land in empty space and a relation's may not
 * (ADR-0038 decision 2), so a release over the board frees one and reverts
 * the other.
 *
 * CONNECTING lives here too, because it is the same question asked while
 * MAKING an element rather than while moving one: a release names a box or
 * it names nowhere, and what that means depends on what can end nowhere.
 * They were written apart and answered it the same way by hand; one module
 * is what keeps them from drifting.
 */

import type { CanvasEdge, CanvasLine, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { endNode } from '@kamiazya/whiteboard-model'
import type { EditorCommand, EndTarget } from '../../lib/spatial/commands.js'
import { endInkCommand } from '../../lib/spatial/commands.js'
import { boxContains } from '../../lib/spatial/geometry.js'
import type { Point } from '../../lib/spatial/viewport.js'

/**
 * One END of one element being dragged.
 *
 * No start point, unlike the bend and move snapshots: a re-attachment is
 * not a translation, so there is no delta to take. What the release names
 * IS the answer — the box under it, or the place it happened.
 */
export interface EndSnapshot {
  readonly kind: 'reattaching'
  readonly elementId: string
  readonly endpoint: 'from' | 'to'
}

/**
 * The element this id names, in whichever collection holds it. The scene
 * hands an edge and a line out identically, so the id an end handle or a
 * bend handle carries could be either.
 *
 * Exported because `gesture-bends.ts` wants the same lookup and had it
 * written out twice more; a third copy is what this replaces. It lives here
 * rather than in a module of its own for now — if a caller outside the two
 * gesture halves appears, that is when it moves.
 */
export function routableElement(
  canvas: SpatialCanvas,
  id: string,
): CanvasEdge | CanvasLine | undefined {
  return (
    canvas.edges.find((edge) => edge.id === id) ??
    (canvas.lines ?? []).find((line) => line.id === id)
  )
}

/** Whether this id still names something with two ends — the drag's target check. */
export function endTargetExists(canvas: SpatialCanvas, id: string): boolean {
  return routableElement(canvas, id) !== undefined
}

/**
 * Where a release lands, in the terms the write takes. A release with no
 * box under it is a bare point; whether that is a legal end at all is the
 * COLLECTION's question, and `endInkCommand` answers it.
 *
 * Rounded to whole units for the reason a dragged bend is: a point somebody
 * dragged to is a point they can find again, and 137.4183 is not.
 */
export function releaseTarget(point: Point, targetNodeId: string | undefined): EndTarget {
  return targetNodeId === undefined
    ? { kind: 'point', point: { x: Math.round(point.x), y: Math.round(point.y) } }
    : { kind: 'node', node: targetNodeId }
}

/**
 * Whether this release would really move the end.
 *
 * Two releases cannot: one that names the box the end is already on, and
 * one that names the box the OTHER end is on. The first is this gesture's
 * `dx === 0 && dy === 0`. The second is a self-loop, which the WRITE
 * refuses and which is checked again here for a different reason — a
 * refused command still reaches `onChange`, so without this it would land
 * in history as an edit somebody can undo and see no difference from.
 */
export function releaseMovesEnd(
  canvas: SpatialCanvas,
  snapshot: EndSnapshot,
  target: EndTarget,
): boolean {
  const element = routableElement(canvas, snapshot.elementId)
  if (element === undefined) return false
  const current = snapshot.endpoint === 'from' ? element.from : element.to
  const other = snapshot.endpoint === 'from' ? element.to : element.from
  if (target.kind === 'node') {
    return endNode(current) !== target.node && endNode(other) !== target.node
  }
  // A free end exists only on a stroke, so a relation's end never matches a
  // point and the write refuses it anyway — this only answers "the stroke
  // is already exactly here".
  if (!('kind' in current) || current.kind !== 'point') return true
  return current.point.x !== target.point.x || current.point.y !== target.point.y
}

/** The write a release makes, or nothing when it would make none. */
export function endCommands(
  canvas: SpatialCanvas,
  snapshot: EndSnapshot,
  point: Point,
  targetNodeId: string | undefined,
): readonly EditorCommand[] {
  const target = releaseTarget(point, targetNodeId)
  if (!releaseMovesEnd(canvas, snapshot, target)) return []
  const command = endInkCommand(canvas, snapshot.elementId, snapshot.endpoint, target)
  return command === undefined ? [] : [command]
}

/**
 * A connect release's outcome, as a description rather than a
 * `GestureResult`.
 *
 * Shaped by `gestures.ts`, which owns `idle` and `stateOnly` — the same
 * split `gesture-bends.ts` makes by answering in commands. Returning the
 * result type here would mean importing those values, and a value import
 * back into `gestures.ts` is the cycle `cycle-check.ts` refuses.
 */
export type ConnectRelease =
  | { readonly kind: 'stay-armed' }
  | { readonly kind: 'cancel' }
  | { readonly kind: 'commands'; readonly commands: readonly EditorCommand[] }

/**
 * What a release ends an armed connect with.
 *
 * Releasing over the SOURCE node keeps it armed: that is the first click of
 * the object-first click-A-click-B flow (the press and its own release both
 * land on A), and in the drag flow it just means "still choosing a target".
 *
 * Releasing over EMPTY canvas draws a line. It used to cancel, and could
 * not have done anything else: an edge is a RELATION and cannot end in
 * empty space, so there was nothing to make. ADR-0038 decision 2 split ink
 * from relation, and a line's end is exactly the `{kind:'point'}` this
 * release has been carrying all along — the same answer `endCommands` gives
 * the same release on an element that already exists.
 *
 * The click flow is unaffected, which is worth stating because it looks
 * like it should be: cancelling an armed connect means pressing empty
 * canvas, and `pointerdown-empty` resets to idle BEFORE its pointerup
 * arrives, so this arm never sees it. The only gesture that changed is a
 * real drag off the connect handle.
 */
export function connectRelease(
  canvas: SpatialCanvas,
  fromNodeId: string,
  point: Point,
  targetNodeId: string | undefined,
  createId: () => string,
): ConnectRelease {
  if (targetNodeId === fromNodeId) return { kind: 'stay-armed' }
  if (targetNodeId === undefined) {
    const source = canvas.nodes.find((node) => node.id === fromNodeId)
    // A release still inside the source box is not a drag anywhere: the
    // handle is drawn on the node and can overhang it, and a line from a box
    // to itself is zero-length ink that cannot then be clicked to remove.
    if (source !== undefined && boxContains(source, point)) return { kind: 'cancel' }
    return {
      kind: 'commands',
      commands: [
        {
          kind: 'create-line',
          line: {
            id: createId(),
            from: { kind: 'node', node: fromNodeId },
            to: { kind: 'point', point: { x: point.x, y: point.y } },
          },
        },
      ],
    }
  }
  return {
    kind: 'commands',
    commands: [
      { kind: 'connect-nodes', edgeId: createId(), fromNode: fromNodeId, toNode: targetNodeId },
    ],
  }
}
