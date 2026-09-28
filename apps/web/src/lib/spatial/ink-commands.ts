import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import type { EditorCommand, EditorLeafCommand, EndTarget } from './commands.js'

/*
 * The ink-id family. The editor's selection holds ink ids without knowing
 * which collection — `edges` or `lines` — each came from, so each VERB has
 * exactly one place that looks, rather than every call site remembering to
 * search two lists. Each answers `undefined` for an id in neither.
 */

/**
 * The delete a selected piece of ink wants, or `undefined` when the canvas
 * holds no such ink.
 *
 * The editor carries ONE selected-ink id rather than one per collection,
 * because the SCENE is where an edge and a line become the same thing:
 * canvas-render routes `[...edges, ...lines]` through one pass and both come
 * out as `kind: 'edge'` scene nodes carrying their own id. So hit-testing,
 * `edgePaths` and the selection highlight already worked on a line before
 * anything here knew lines existed.
 *
 * Deleting is the step that has to know which collection, and this is the one
 * place that decides — rather than each call site remembering to look in two
 * lists. An id in neither answers `undefined` instead of a delete aimed at a
 * guess: a stale selection must not remove whatever happens to share its id.
 */
export function deleteInkCommand(canvas: SpatialCanvas, id: string): EditorCommand | undefined {
  if (canvas.edges.some((edge) => edge.id === id)) return { kind: 'delete-edge', id }
  if ((canvas.lines ?? []).some((line) => line.id === id)) return { kind: 'delete-line', id }
  return undefined
}

/**
 * `deleteInkCommand`'s sibling for a MOVE, and the same reason for existing:
 * the selection holds ink ids without knowing which collection each came
 * from, and exactly one place should look.
 *
 * An EDGE answers `undefined` rather than a command that would do nothing. A
 * relation's path is routed from the boxes it joins, so there is no geometry
 * of its own to translate — moving one means moving an end or placing a bend.
 * A caller nudging a mixed selection therefore moves the strokes and leaves
 * the relations to follow the nodes they connect, which is what a person
 * watching the board expects either way.
 */
export function moveInkCommand(
  canvas: SpatialCanvas,
  id: string,
  dx: number,
  dy: number,
): EditorLeafCommand | undefined {
  return (canvas.lines ?? []).some((line) => line.id === id)
    ? { kind: 'move-line', id, dx, dy }
    : undefined
}

/**
 * The third of the ink-id siblings, and the reason there is a family: the
 * selection carries ink ids without knowing which collection each came from,
 * so exactly one place per VERB looks, rather than every call site
 * remembering to search two lists.
 *
 * Unlike the move, both collections answer — a relation's bends are as real
 * as a stroke's, and the drag affordance is the same one.
 */
export function bendInkCommand(
  canvas: SpatialCanvas,
  id: string,
  bends: readonly { readonly x: number; readonly y: number }[],
): EditorLeafCommand | undefined {
  if (canvas.edges.some((edge) => edge.id === id)) return { kind: 'set-edge-bends', id, bends }
  if ((canvas.lines ?? []).some((line) => line.id === id))
    return { kind: 'set-line-bends', id, bends }
  return undefined
}

/**
 * The label write, picked by collection.
 *
 * The renderer has drawn a line's label all along — `composeEdgeLabel` takes
 * a `RoutableElement` — so this was never a rendering gap and only ever an
 * editing one: the in-place editor and the menu verb both named
 * `canvas.edges`, so a stroke could carry a name that nothing could write or
 * clear.
 */
export function labelInkCommand(
  canvas: SpatialCanvas,
  id: string,
  label: string,
): EditorLeafCommand | undefined {
  if (canvas.edges.some((edge) => edge.id === id)) return { kind: 'set-edge-label', id, label }
  if ((canvas.lines ?? []).some((line) => line.id === id))
    return { kind: 'set-line-label', id, label }
  return undefined
}

/**
 * The end write, picked by collection — the fifth of the ink-id siblings,
 * and the only one that can answer "there is no such write".
 *
 * A relation cannot end in empty space (ADR-0038 decision 2), so a drop
 * there has no command behind it; the gesture reads the `undefined` and
 * leaves the end where it was. That is a product decision rather than a
 * schema one — an edge could have been turned into a line instead — and it
 * is written here because this is the one place that knows both.
 */
export function endInkCommand(
  canvas: SpatialCanvas,
  id: string,
  endpoint: 'from' | 'to',
  target: EndTarget,
): EditorLeafCommand | undefined {
  if (canvas.edges.some((edge) => edge.id === id))
    return target.kind === 'node'
      ? { kind: 'set-edge-end', id, endpoint, node: target.node }
      : undefined
  if ((canvas.lines ?? []).some((line) => line.id === id))
    return { kind: 'set-line-end', id, endpoint, target }
  return undefined
}
