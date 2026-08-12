import type { z } from 'zod'

/** Thrown when a patch tool targets a canvas that has no saved snapshot yet. */
export class CanvasDocNotFoundError extends Error {
  constructor(public readonly canvasId: string) {
    super(`canvas doc not found: ${canvasId}`)
    this.name = 'CanvasDocNotFoundError'
  }
}

/** Thrown when a patch tool targets a nodeId absent from the canvas. */
export class NodeNotFoundError extends Error {
  constructor(
    public readonly canvasId: string,
    public readonly nodeId: string,
  ) {
    super(`node not found: ${nodeId} in canvas ${canvasId}`)
    this.name = 'NodeNotFoundError'
  }
}

/**
 * Thrown when a mutation targets a node the user has locked. The lock
 * binds agents too, not just the pointer (user decision 2026-08-09) —
 * `wb_wb_node_lock` is the one tool that still accepts a locked node, so an
 * agent can lift its own mistake without a human at the keyboard.
 */
export class NodeLockedError extends Error {
  constructor(
    public readonly canvasId: string,
    public readonly nodeId: string,
  ) {
    super(`node is locked: ${nodeId} in canvas ${canvasId} (unlock it with wb_node_lock)`)
    this.name = 'NodeLockedError'
  }
}

/** Edge counterpart to `NodeLockedError` — see `wb_wb_edge_lock`. */
export class EdgeLockedError extends Error {
  constructor(
    public readonly canvasId: string,
    public readonly edgeId: string,
  ) {
    super(`edge is locked: ${edgeId} in canvas ${canvasId} (unlock it with wb_edge_lock)`)
    this.name = 'EdgeLockedError'
  }
}

/** Thrown when a patch tool targets an edgeId absent from the canvas. */
export class EdgeNotFoundError extends Error {
  constructor(
    public readonly canvasId: string,
    public readonly edgeId: string,
  ) {
    super(`edge not found: ${edgeId} in canvas ${canvasId}`)
    this.name = 'EdgeNotFoundError'
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
 * Thrown when `wb_wb_body_patch` targets a node whose `type` is not `'text'`
 * — a distinct failure mode from `PatchValidationError` (wrong node kind
 * chosen by the caller, not a schema violation produced by a valid patch).
 */
export class NotATextNodeError extends Error {
  constructor(
    public readonly canvasId: string,
    public readonly nodeId: string,
    public readonly actualType: string,
  ) {
    super(`node ${nodeId} in canvas ${canvasId} is not a text node (type: ${actualType})`)
    this.name = 'NotATextNodeError'
  }
}
