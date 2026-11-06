import { selectCanvasFragment } from '@kamiazya/whiteboard-canvas-render'
import type { CommentThread, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { endNode } from '@kamiazya/whiteboard-model'

/** Which part of a canvas a picture export draws: the nodes a person had selected. */
export interface ExportScope {
  readonly nodeIds: readonly string[]
}

interface Box {
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
}

const inside = (box: Box, x: number, y: number) =>
  x >= box.left && x <= box.right && y >= box.top && y <= box.bottom

/** Whether a conversation's anchor is about something the picture keeps. */
function anchorKept(
  anchor: CommentThread['anchor'],
  ids: ReadonlySet<string>,
  edgeIds: ReadonlySet<string>,
  box: Box,
): boolean {
  if (anchor.kind === 'document') return false
  if (anchor.kind === 'text') return anchor.nodeId !== undefined && ids.has(anchor.nodeId)
  if (anchor.nodeId !== undefined) return ids.has(anchor.nodeId)
  if (anchor.edgeId !== undefined) return edgeIds.has(anchor.edgeId)
  if (anchor.nodeIds !== undefined) return anchor.nodeIds.some((id) => ids.has(id))
  return inside(box, anchor.x, anchor.y)
}

/**
 * What a picture export draws: the whole canvas with every conversation, or,
 * given a selection, `selectionPicture`'s part of it.
 */
export function pictureSubject(
  canvas: SpatialCanvas,
  {
    threads,
    selection,
  }: { readonly threads?: readonly CommentThread[]; readonly selection?: readonly string[] },
): { readonly canvas: SpatialCanvas; readonly threads: readonly CommentThread[] } {
  return selection === undefined
    ? { canvas, threads: threads ?? [] }
    : selectionPicture(canvas, threads ?? [], selection)
}

/**
 * The picture of a selection: each selected node read as the durable
 * fragment `^id` names (so a selected frame brings its members, the way an
 * embed of `#Label` does), unioned, with what belongs to that union and
 * nothing else — an edge or ink both of whose attached ends it holds, a
 * free end or a spot comment only inside its bounds, a comment or
 * conversation only about something kept.
 *
 * A selection naming nothing on the board answers the board itself, so a
 * stale selection never exports an empty picture.
 */
function selectionPicture(
  canvas: SpatialCanvas,
  threads: readonly CommentThread[],
  nodeIds: readonly string[],
): { readonly canvas: SpatialCanvas; readonly threads: readonly CommentThread[] } {
  const ids = new Set<string>()
  for (const id of nodeIds) {
    for (const node of selectCanvasFragment(canvas, `^${id}`)?.nodes ?? []) ids.add(node.id)
  }
  if (ids.size === 0) return { canvas, threads }
  const nodes = canvas.nodes.filter((node) => ids.has(node.id))
  const box: Box = {
    left: Math.min(...nodes.map((n) => n.x)),
    top: Math.min(...nodes.map((n) => n.y)),
    right: Math.max(...nodes.map((n) => n.x + n.width)),
    bottom: Math.max(...nodes.map((n) => n.y + n.height)),
  }
  const edges = canvas.edges.filter((edge) => {
    const from = endNode(edge.from)
    const to = endNode(edge.to)
    return from !== undefined && to !== undefined && ids.has(from) && ids.has(to)
  })
  const edgeIds = new Set(edges.map((edge) => edge.id))
  const lines = canvas.lines?.filter((line) =>
    [line.from, line.to].every((end) =>
      end.kind === 'node' ? ids.has(end.node) : inside(box, end.point.x, end.point.y),
    ),
  )
  const keptThreads = threads.filter(({ anchor }) => anchorKept(anchor, ids, edgeIds, box))
  return {
    canvas: {
      ...canvas,
      nodes,
      edges,
      ...(lines === undefined ? {} : { lines }),
    },
    threads: keptThreads,
  }
}
