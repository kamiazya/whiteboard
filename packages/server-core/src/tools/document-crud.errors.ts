/**
 * Typed error contract for canvas-CRUD handlers. `create-server.ts` maps
 * these classes — never a message string — to HTTP status codes, so
 * rewording an error cannot silently change the API's status codes.
 *
 * They exist alongside `DocumentIndex`'s own errors because these carry
 * advice aimed at an MCP caller; the port's are mapped to status codes
 * directly where no such advice applies.
 */
export class WorkspaceDocumentNotFoundError extends Error {
  constructor(
    readonly workspaceId: string,
    readonly documentId: string,
  ) {
    super(`Canvas not found: ${documentId} in workspace ${workspaceId}`)
    this.name = 'WorkspaceDocumentNotFoundError'
  }
}

export class WorkspaceNotFoundError extends Error {
  constructor(readonly workspaceId: string) {
    super(
      `Workspace not found: "${workspaceId}". ` +
        'Pass createWorkspace: true to create it along with the canvas.',
    )
    this.name = 'WorkspaceNotFoundError'
  }
}
