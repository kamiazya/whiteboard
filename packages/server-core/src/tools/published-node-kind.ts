/**
 * The word the CANVAS TOOLS call a node's kind, which is not the model's.
 *
 * [ADR-0038](../../../../docs/contributing/adr/0038-ocif-projection.md)
 * decision 3 made what a node shows a RESOURCE and derived the kind from it,
 * so `nodeKind` says `frame` and answers `undefined` for a resource this
 * build cannot read. `wb_canvas_edit` and `wb_canvas_snapshot` have published
 * `text | file | link | group` since they existed, a model reads that table
 * on every turn, and converging it on the model's vocabulary is a
 * tool-surface change with its own criteria (ADR-0031).
 *
 * So every message and every projection on the tools' surface goes through
 * this, and the flip stays a storage change no caller can see. A refusal that
 * suddenly read "a frame node has no text" would be a surface change nobody
 * gated.
 *
 * Its own module rather than a helper beside either tool: `canvas-edit-ops`
 * already imports `canvas-snapshot`'s output schema, so putting it in either
 * one makes a value-import cycle `cycle-check.ts` fails on.
 */
import { nodeKind, type SpatialNode } from '@kamiazya/whiteboard-model'

export type PublishedNodeKind = 'text' | 'file' | 'link' | 'group'

export const publishedKind = (node: SpatialNode): PublishedNodeKind => {
  const kind = nodeKind(node)
  // A frame and an unreadable resource are both `group`: the wire's node that
  // shows nothing, which is the same fallback the JSON Canvas projection takes.
  return kind === undefined || kind === 'frame' ? 'group' : kind
}
