/**
 * Typed error contract for canvas-CRUD handlers. `create-server.ts` maps
 * these classes (never message-string matching against
 * `WorkspaceTree`'s thrown errors) to HTTP status codes, so a future
 * wording change in `WorkspaceTree`'s error messages cannot silently
 * change the API's status-code behavior.
 */
export class CanvasNotFoundError extends Error {
  constructor(
    readonly workspaceId: string,
    readonly canvasId: string,
  ) {
    super(`Canvas not found: ${canvasId} in workspace ${workspaceId}`)
    this.name = 'CanvasNotFoundError'
  }
}

export class CanvasSegmentConflictError extends Error {
  constructor(readonly segment: string) {
    super(`Segment conflict: "${segment}" already exists under this parent`)
    this.name = 'CanvasSegmentConflictError'
  }
}

export class CanvasParentNotFoundError extends Error {
  constructor(readonly parentId: string) {
    super(`Parent node not found: ${parentId}`)
    this.name = 'CanvasParentNotFoundError'
  }
}
