import { type ClipboardFragment, endNode, type SpatialCanvas } from '@kamiazya/whiteboard-model'
import { remintClipboardFragment } from '../clipboard-fragment.js'
import { type EditorCommand, ownedLinePoints, shiftLine } from './commands.js'
import type { Point } from './viewport.js'

/** Standard duplicate-again cascade offset — also `pasteFragment`'s
 * fallback when it is given no anchor point. */
export const DUPLICATE_OFFSET_PX = 16

/**
 * The shared core of `pasteFragment` and `duplicateSelection`: remint a
 * fragment's ids against `canvas`'s existing ones, then batch it in as
 * `create-node`/`create-edge`, offset either by the standard +16/+16
 * duplicate cascade (no anchor) or so its bounding-box center lands on
 * `anchor` (rounded) — the "Paste here" placement. Undefined for an
 * empty-node fragment, matching every other command builder's totality
 * contract: nothing to insert is nothing to command.
 */
export function buildFragmentInsertCommand(
  canvas: SpatialCanvas,
  fragment: Pick<ClipboardFragment, 'nodes' | 'edges' | 'lines' | 'cut'>,
  createId: () => string,
  anchor?: Point,
): EditorCommand | undefined {
  // Ink alone is a fragment, not an empty clipboard.
  if (fragment.nodes.length === 0 && (fragment.lines ?? []).length === 0) return undefined
  const existingIds = new Set([
    ...canvas.nodes.map((node) => node.id),
    ...canvas.edges.map((edge) => edge.id),
    ...(canvas.lines ?? []).map((line) => line.id),
  ])
  const reminted = remintClipboardFragment(fragment, createId, existingIds)
  let dx = DUPLICATE_OFFSET_PX
  let dy = DUPLICATE_OFFSET_PX
  if (anchor !== undefined) {
    // Read from the boxes AND the strokes, because either may be the whole
    // fragment: over nodes alone an ink-only paste computed `Infinity` and
    // landed nowhere a person could find it.
    const xs = [
      ...reminted.nodes.flatMap((node) => [node.x, node.x + node.width]),
      ...reminted.lines.flatMap((line) => ownedLinePoints(line).map((point) => point.x)),
    ]
    const ys = [
      ...reminted.nodes.flatMap((node) => [node.y, node.y + node.height]),
      ...reminted.lines.flatMap((line) => ownedLinePoints(line).map((point) => point.y)),
    ]
    // A fragment of strokes hung entirely on boxes owns no point of its own,
    // and there is nothing to centre; the cascade offset is the honest
    // answer rather than a NaN.
    if (xs.length > 0 && ys.length > 0) {
      dx = Math.round(anchor.x - (Math.min(...xs) + Math.max(...xs)) / 2)
      dy = Math.round(anchor.y - (Math.min(...ys) + Math.max(...ys)) / 2)
    }
  }
  // A cut fragment reconnects its severed boundary edges to peers that
  // still exist on THIS canvas (same-canvas paste is a move); a missing
  // peer means a cross-canvas paste or a deleted neighbour, and the edge
  // drops silently — exactly what a plain copy would have done.
  const canvasNodeIds = new Set(canvas.nodes.map((node) => node.id))
  const canvasEdgeIds = new Set(canvas.edges.map((edge) => edge.id))
  const boundaryEdges = (fragment.cut?.boundaryEdges ?? []).flatMap((edge) => {
    // The original edge still exists → it was never actually severed (the
    // cut was lifted, or resolved as a move): nothing to reconnect, and a
    // second wire onto the peer would be the new defect.
    if (canvasEdgeIds.has(edge.id)) return []
    // A boundary edge crosses the cut, so exactly one end is being re-minted
    // and the other must already be on the canvas. A FREE end is neither, so
    // an edge carrying one is never a boundary edge.
    const fromId = endNode(edge.from)
    const toId = endNode(edge.to)
    if (fromId === undefined || toId === undefined) return []
    const from = reminted.idMap.get(fromId)
    const to = reminted.idMap.get(toId)
    if ((from === undefined) === (to === undefined)) return []
    const peer = from === undefined ? fromId : toId
    if (!canvasNodeIds.has(peer)) return []
    return [
      {
        ...edge,
        id: reminted.mintId(),
        from: { ...edge.from, kind: 'node' as const, node: from ?? fromId },
        to: { ...edge.to, kind: 'node' as const, node: to ?? toId },
      },
    ]
  })
  return {
    kind: 'batch',
    commands: [
      ...reminted.nodes.map(
        (node) =>
          ({ kind: 'create-node', node: { ...node, x: node.x + dx, y: node.y + dy } }) as const,
      ),
      ...[...reminted.edges, ...boundaryEdges].map(
        (edge) => ({ kind: 'create-edge', edge }) as const,
      ),
      ...reminted.lines.map(
        (line) => ({ kind: 'create-line', line: shiftLine(line, dx, dy) }) as const,
      ),
    ],
  }
}
