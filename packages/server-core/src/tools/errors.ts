import type { DocumentKind } from '@kamiazya/whiteboard-model'
import type { z } from 'zod'

/**
 * Thrown when a write is in a format the document is not in.
 *
 * A document's kind decides which writes make sense on it, and the two
 * content writes overlap on the same stored structure — a markdown
 * document keeps its OKF body in a spatial text node — so an unguarded
 * cross-format write does not fail, it destroys. `detail` carries the
 * per-tool consequence and the tool to use instead.
 */
export class DocumentKindMismatchError extends Error {
  constructor(
    public readonly documentId: string,
    public readonly kind: DocumentKind,
    detail: string,
  ) {
    super(`Document ${documentId} is a ${kind} document. ${detail}`)
    this.name = 'DocumentKindMismatchError'
  }
}

/**
 * Thrown when a write would discard content rather than edit it. A document
 * that records no kind is declared by the first write that reaches it — but
 * only when there is nothing to lose. `DocumentKindMismatchError` is what
 * normally refuses a destructive write, and an absent kind is precisely the
 * case it cannot judge.
 */
export class DocumentContentLossError extends Error {
  constructor(
    public readonly documentId: string,
    detail: string,
  ) {
    super(`Document ${documentId} records no kind and is not empty. ${detail}`)
    this.name = 'DocumentContentLossError'
  }
}

/** Thrown when a patch tool targets a nodeId absent from the canvas. */
export class NodeNotFoundError extends Error {
  constructor(
    public readonly documentId: string,
    public readonly nodeId: string,
  ) {
    super(`node not found: ${nodeId} in canvas ${documentId}`)
    this.name = 'NodeNotFoundError'
  }
}

/**
 * Thrown when a patch's merged result fails `spatialCanvasSchema`
 * validation — e.g. an edge patch retargets `fromNode`/`toNode` to a
 * nonexistent node id. Reuses the schema's own cross-field invariant
 * instead of a parallel hand-rolled existence check.
 */
export class PatchValidationError extends Error {
  constructor(public readonly issues: z.ZodIssue[]) {
    super(`patch produced an invalid canvas: ${issues.map((issue) => issue.message).join('; ')}`)
    this.name = 'PatchValidationError'
  }
}

/**
 * Thrown when `wb_body_patch` targets a node whose `type` is not `'text'`
 * — a distinct failure mode from `PatchValidationError` (wrong node kind
 * chosen by the caller, not a schema violation produced by a valid patch).
 */
export class NotATextNodeError extends Error {
  constructor(
    public readonly documentId: string,
    public readonly nodeId: string,
    public readonly actualType: string,
  ) {
    super(`node ${nodeId} in canvas ${documentId} is not a text node (type: ${actualType})`)
    this.name = 'NotATextNodeError'
  }
}

/**
 * Thrown when `wb_facet_set` refuses a facet the registry knows: an invalid
 * payload for a registered facet, a non-current version key, or a target the
 * definition does not declare (ADR-0013 decision 6 — write-side validation).
 * Unregistered facets never reach this: they pass through unvalidated.
 */
export class FacetWriteRejectedError extends Error {
  constructor(
    public readonly facetKey: string,
    reason: string,
  ) {
    super(`facet "${facetKey}" rejected: ${reason}`)
    this.name = 'FacetWriteRejectedError'
  }
}

/**
 * Thrown when a proposed passage cannot be applied to the body as it now
 * stands — either its quote no longer appears, or it appears with different
 * words than the caller assumed.
 *
 * Names the CHANGE rather than the document, because a batch refused for one
 * passage has to say which one: the caller's next move is to re-read that
 * passage, and a message naming only the document leaves it re-reading
 * everything.
 */
export class PassageNotApplicableError extends Error {
  constructor(
    public readonly changeId: string,
    detail: string,
  ) {
    super(`Passage ${changeId} does not apply: ${detail}`)
    this.name = 'PassageNotApplicableError'
  }
}
