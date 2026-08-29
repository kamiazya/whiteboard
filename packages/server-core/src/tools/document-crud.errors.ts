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

/**
 * ADR-0019: creating a workspace mints its canonical id here and files the
 * caller's string as the `segment` — so a handle that could never BE a
 * segment is refused rather than minted with none.
 *
 * The alternative reads as success and is not: the workspace would exist,
 * keyed by an id the caller has to fish out of the response, while the
 * address they chose named nothing from their very next request onward.
 *
 * A BACKFILL of already-stored workspaces settles for a NULL segment on the
 * same input (migration 0019), and the difference is principled rather than
 * inconsistent: a backfill has data it must not discard, and a create has
 * nothing yet.
 */
export class WorkspaceSegmentUnusableError extends Error {
  constructor(readonly handle: string) {
    super(
      `Cannot create workspace "${handle}": a new workspace is addressed by its segment, ` +
        'which must be ASCII letters, digits and interior hyphens, and must not itself be ' +
        'shaped like a canonical id. Choose a name that fits, or address an existing ' +
        'workspace by its id.',
    )
    this.name = 'WorkspaceSegmentUnusableError'
  }
}
