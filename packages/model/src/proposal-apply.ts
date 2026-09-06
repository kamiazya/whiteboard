import type { SpatialProposedChange } from './proposal.js'
import type { CanvasEdge, SpatialCanvas, SpatialNode } from './spatial.js'

/**
 * What adopting a proposed change MEANS, and whether it still fits (ADR-0029
 * decisions 4 and 5).
 *
 * Both are pure and both live beside the schema rather than in whichever
 * surface adopts first. The web editor adopts, and an MCP verb will adopt the
 * same way; a second reading of "what does this change mean" would be free to
 * disagree with the first, which is the whole reason a proposal carries a
 * resolved op instead of a description.
 *
 * Neither judges `body.replace`. That arm is a passage of prose and its
 * subject is the body, not the canvas — so it is excluded by TYPE rather
 * than answered `false`, which would be a verdict nobody computed.
 */

type Fields = Record<string, unknown>

function patchedInto<T>(element: T, patch: Fields): T {
  return { ...element, ...patch }
}

/**
 * The canvas with the change applied, or the canvas unchanged when the
 * element it names is not there.
 *
 * Idempotent, because two people pressing Adopt on one change — or one
 * person pressing it twice — is an ordinary race rather than an error. A
 * patch re-applied sets the same fields; an add whose id is present is
 * skipped; a remove of something already gone changes nothing.
 */
export function applyCanvasChange(
  canvas: SpatialCanvas,
  change: SpatialProposedChange,
): SpatialCanvas {
  switch (change.op) {
    case 'node.add':
      if (canvas.nodes.some((node) => node.id === change.node.id)) return canvas
      return { ...canvas, nodes: [...canvas.nodes, change.node] }
    case 'node.patch': {
      if (!canvas.nodes.some((node) => node.id === change.nodeId)) return canvas
      return {
        ...canvas,
        nodes: canvas.nodes.map((node) =>
          node.id === change.nodeId ? patchedInto(node, change.patch as Fields) : node,
        ),
      }
    }
    case 'node.remove': {
      if (!canvas.nodes.some((node) => node.id === change.nodeId)) return canvas
      // An edge to a node that is gone is not a canvas anything can render,
      // and `spatialCanvasSchema` refuses it — so adopting the removal takes
      // the edges that would dangle with it, the way the editor's own delete
      // does. Silently leaving them would make the adopted board unsavable.
      return {
        nodes: canvas.nodes.filter((node) => node.id !== change.nodeId),
        ...(canvas['x-whiteboard'] === undefined ? {} : { 'x-whiteboard': canvas['x-whiteboard'] }),
        edges: canvas.edges.filter(
          (edge) => edge.fromNode !== change.nodeId && edge.toNode !== change.nodeId,
        ),
      }
    }
    case 'edge.add':
      if (canvas.edges.some((edge) => edge.id === change.edge.id)) return canvas
      return { ...canvas, edges: [...canvas.edges, change.edge] }
    case 'edge.patch':
      if (!canvas.edges.some((edge) => edge.id === change.edgeId)) return canvas
      return {
        ...canvas,
        edges: canvas.edges.map((edge) =>
          edge.id === change.edgeId ? patchedInto(edge, change.patch as Fields) : edge,
        ),
      }
    case 'edge.remove':
      return { ...canvas, edges: canvas.edges.filter((edge) => edge.id !== change.edgeId) }
  }
}

/**
 * Whether the anchor still holds what the proposal assumed it held.
 *
 * This is decision 5 exactly, and what it deliberately does NOT flag is the
 * point: an edit to a field the change never touches is somebody else's work
 * on the same element, not a collision. A prior that OMITS a field claims the
 * anchor held nothing there, so a value APPEARING is as much a collision as
 * one changing — which is why the comparison is against `undefined` rather
 * than skipped.
 *
 * The element being gone is a conflict for every arm that names one: there is
 * no longer an anchor to follow. An addition has no prior at all, so its only
 * possible collision is somebody taking its id first.
 */
export function canvasChangeConflicts(
  change: SpatialProposedChange,
  canvas: SpatialCanvas,
): boolean {
  switch (change.op) {
    case 'node.add':
      return canvas.nodes.some((node) => node.id === change.node.id)
    case 'edge.add':
      return canvas.edges.some((edge) => edge.id === change.edge.id)
    case 'node.patch': {
      const node = canvas.nodes.find((candidate) => candidate.id === change.nodeId)
      if (node === undefined) return true
      return differsFromPrior(node as Fields, change.patch as Fields, change.assumed as Fields)
    }
    case 'edge.patch': {
      const edge = canvas.edges.find((candidate) => candidate.id === change.edgeId)
      if (edge === undefined) return true
      return differsFromPrior(edge as Fields, change.patch as Fields, change.assumed as Fields)
    }
    case 'node.remove': {
      const node = canvas.nodes.find((candidate) => candidate.id === change.nodeId)
      return node === undefined || !sameElement(node, change.assumed)
    }
    case 'edge.remove': {
      const edge = canvas.edges.find((candidate) => candidate.id === change.edgeId)
      return edge === undefined || !sameElement(edge, change.assumed)
    }
  }
}

/** True when any field the change SETS no longer holds what the prior said. */
function differsFromPrior(current: Fields, patch: Fields, assumed: Fields): boolean {
  return Object.keys(patch).some((field) => !Object.is(current[field], assumed[field]))
}

/**
 * A removal's prior is the WHOLE element, so anything about it changing is a
 * collision — the person deleting it would be deleting something other than
 * what they were shown.
 */
function sameElement(
  current: SpatialNode | CanvasEdge,
  assumed: SpatialNode | CanvasEdge,
): boolean {
  const a = current as Fields
  const b = assumed as Fields
  const fields = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const field of fields) {
    const left = a[field]
    const right = b[field]
    if (Object.is(left, right)) continue
    // One level of structure, for a node's `x-whiteboard` embed. Deeper than
    // that a JSON comparison is the honest tool, and no element goes deeper.
    if (JSON.stringify(left) !== JSON.stringify(right)) return false
  }
  return true
}
