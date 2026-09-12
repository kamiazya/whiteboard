import type { BodyProposedChange, SpatialProposedChange } from './proposal.js'
import type { CanvasEdge, CanvasLine, SpatialCanvas, SpatialNode } from './spatial.js'
import { endNode } from './spatial.js'

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
 * The two canvas functions are excluded from judging `body.replace` by TYPE
 * rather than answering `false`, which would be a verdict nobody computed;
 * `applyBodyChange` and `bodyChangeConflicts` at the foot of this file are
 * its prose twins (decision 6). They live here, beside the canvas pair, for
 * the reason above: what adopting means is one reading.
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
        ...canvas,
        nodes: canvas.nodes.filter((node) => node.id !== change.nodeId),
        edges: canvas.edges.filter(
          (edge) => endNode(edge.from) !== change.nodeId && endNode(edge.to) !== change.nodeId,
        ),
        // Ink anchored to the node goes with it for the same reason, and ink
        // anchored to nothing stays: a line's free end names no node, so there
        // is nothing for the removal to dangle (ADR-0038 decision 2).
        ...(canvas.lines === undefined
          ? {}
          : {
              lines: canvas.lines.filter(
                (line) =>
                  endNode(line.from) !== change.nodeId && endNode(line.to) !== change.nodeId,
              ),
            }),
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
    case 'line.add':
      if ((canvas.lines ?? []).some((line) => line.id === change.line.id)) return canvas
      return { ...canvas, lines: [...(canvas.lines ?? []), change.line] }
    case 'line.patch':
      if (!(canvas.lines ?? []).some((line) => line.id === change.lineId)) return canvas
      return {
        ...canvas,
        lines: (canvas.lines ?? []).map((line) =>
          line.id === change.lineId ? patchedInto(line, change.patch as Fields) : line,
        ),
      }
    case 'line.remove':
      // The collection is left ABSENT rather than emptied when the last line
      // goes, because absence is what the canvas carried before any ink did
      // and `spatialCanvasSchema` makes `lines` optional — an empty array
      // would be a second spelling of the same board.
      return withLines(
        canvas,
        (canvas.lines ?? []).filter((line) => line.id !== change.lineId),
      )
  }
}

const withLines = (canvas: SpatialCanvas, lines: SpatialCanvas['lines']): SpatialCanvas => {
  if (lines === undefined || lines.length === 0) {
    const { lines: _dropped, ...rest } = canvas
    return rest
  }
  return { ...canvas, lines }
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
    case 'line.add':
      return (canvas.lines ?? []).some((line) => line.id === change.line.id)
    case 'line.patch': {
      const line = (canvas.lines ?? []).find((candidate) => candidate.id === change.lineId)
      if (line === undefined) return true
      return differsFromPrior(line as Fields, change.patch as Fields, change.assumed as Fields)
    }
    case 'line.remove': {
      const line = (canvas.lines ?? []).find((candidate) => candidate.id === change.lineId)
      return line === undefined || !sameElement(line, change.assumed)
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
  current: SpatialNode | CanvasEdge | CanvasLine,
  assumed: SpatialNode | CanvasEdge | CanvasLine,
): boolean {
  const a = current as Fields
  const b = assumed as Fields
  const fields = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const field of fields) {
    const left = a[field]
    const right = b[field]
    if (Object.is(left, right)) continue
    // One level of structure, for a node's `embed` and its facets bucket.
    // Deeper than that a JSON comparison is the honest tool, and no element
    // goes deeper.
    if (JSON.stringify(left) !== JSON.stringify(right)) return false
  }
  return true
}

/**
 * A passage of prose (ADR-0029 decision 6): the range of body text a change
 * points at, as the caller RESOLVED it.
 *
 * Resolution is deliberately not done here. A body is a CRDT, and where a
 * passage now sits is answered first by the Loro mark that followed the
 * characters (ADR-0026's order: mark → unique quote → quote with context →
 * orphaned) — which this package cannot see and must not guess at. The
 * caller has already resolved the anchor in order to DRAW the proposal, so
 * asking it for the answer costs nothing and keeps one resolver rather than
 * a second that could disagree.
 *
 * `undefined` means the passage could not be placed at all — the prose
 * equivalent of an element that is gone.
 */
export interface ResolvedPassage {
  readonly start: number
  readonly end: number
}

/**
 * The body with the passage replaced, or the body unchanged when the passage
 * could not be placed.
 *
 * Idempotent in the same sense `applyCanvasChange` is, and by the same
 * argument: adopting twice is an ordinary race. Re-applying against a body
 * that already carries the replacement — resolved to where the replacement
 * now is — writes the same characters back over themselves.
 *
 * An empty passage is an INSERTION and empty text is a DELETION; neither is
 * a special case here, because a splice already means both.
 */
export function applyBodyChange(
  body: string,
  change: BodyProposedChange,
  at: ResolvedPassage | undefined,
): string {
  if (at === undefined) return body
  return body.slice(0, at.start) + change.text + body.slice(at.end)
}

/**
 * Whether the passage still reads what the proposal assumed it read.
 *
 * This is decision 5 for prose, and what it deliberately does NOT flag is
 * the same thing: an edit ELSEWHERE in the body moves every offset below it
 * without touching this passage, and a resolver that followed the passage
 * reports it in its new place. That is somebody working, not a collision.
 *
 * A passage that cannot be placed is a conflict, for the reason a missing
 * element is one: there is no longer an anchor to follow.
 */
export function bodyChangeConflicts(
  change: BodyProposedChange,
  body: string,
  at: ResolvedPassage | undefined,
): boolean {
  if (at === undefined) return true
  // A range the body does not have is unplaceable, and this function's own
  // rule for that is above: it is a conflict. Said explicitly because
  // `String.slice` CLAMPS — a range past the end returns the body's TAIL
  // rather than nothing, and a tail that happens to read what was assumed
  // answers "no conflict". The direction of that mistake is adopting an edit
  // onto text the proposer was never shown.
  if (at.end > body.length || at.start > at.end) return true
  return body.slice(at.start, at.end) !== change.assumed
}
