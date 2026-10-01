import { anchoredOnAny, type SpatialCanvas } from './spatial.js'

/**
 * The canvas with these nodes removed, and with them every edge and line
 * anchored on one of them.
 *
 * ONE definition of what removing a node means, because the invariant it
 * keeps — no end names a node that is gone — is `spatialCanvasSchema`'s, and
 * four surfaces each wrote their own copy of it: the editor's command, the
 * proposal adopt, the agent's `node.remove`, and the Loro write. The Loro
 * copy dropped edges and forgot lines, so a box deleted in the editor left
 * its ink anchored to nothing in the persisted document while the canvas on
 * screen showed it gone. The Loro writer iterates maps rather than folding a
 * canvas, so it calls `anchoredOnAny` directly; the sweep is the same either
 * way.
 *
 * Unknown ids are ignored, so a removal of something already gone changes
 * nothing — the adopt path relies on that being idempotent. `lines` is
 * omitted when it would be empty, matching what the model canonicalises to.
 */
export function withoutNodes(canvas: SpatialCanvas, ids: ReadonlySet<string>): SpatialCanvas {
  const lines = canvas.lines?.filter((line) => !anchoredOnAny(line, ids))
  const { lines: _dropped, ...rest } = canvas
  return {
    ...rest,
    nodes: canvas.nodes.filter((node) => !ids.has(node.id)),
    edges: canvas.edges.filter((edge) => !anchoredOnAny(edge, ids)),
    ...(lines !== undefined && lines.length > 0 ? { lines } : {}),
  }
}
