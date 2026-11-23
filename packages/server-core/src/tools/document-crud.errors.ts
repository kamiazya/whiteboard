import {
  DocumentNameConflict,
  DocumentNotFound,
  WorkspaceNotFoundForCallerCreate,
  WorkspaceNotFoundForCallerCreateKnown,
  WorkspaceNotFoundForCallerRead,
  WorkspaceNotFoundForCallerReadKnown,
  WorkspaceSegmentUnusable,
} from '@kamiazya/whiteboard-model'

/**
 * Typed error contract for canvas-CRUD handlers. `create-server.ts` maps
 * these classes — never a message string — to HTTP status codes, so
 * rewording an error cannot silently change the API's status codes.
 *
 * They exist alongside `DocumentIndex`'s own errors because these carry
 * advice aimed at an MCP caller; the port's are mapped to status codes
 * directly where no such advice applies. `WorkspaceNotFoundForCallerError` is
 * named apart from the port's `WorkspaceNotFoundError` on purpose: one
 * condition, two classes, and a bare name would have to be aliased wherever
 * both are caught.
 */
export class WorkspaceDocumentNotFoundError extends Error {
  constructor(
    readonly workspaceId: string,
    readonly documentId: string,
  ) {
    super(DocumentNotFound(documentId, workspaceId))
    this.name = 'WorkspaceDocumentNotFoundError'
  }
}

/**
 * What the caller was doing decides the advice: a create can carry
 * `createWorkspace: true` on the call it just made, while a read has no
 * such parameter, and naming one it does not take sends a model to the
 * wrong tool.
 */
export type WorkspaceNotFoundIntent = 'create' | 'read'

function workspaceNotFoundMessage(
  workspaceId: string,
  intent: WorkspaceNotFoundIntent,
  known: readonly string[],
): string {
  if (intent === 'create') {
    return known.length === 0
      ? WorkspaceNotFoundForCallerCreate(workspaceId)
      : WorkspaceNotFoundForCallerCreateKnown(workspaceId, known)
  }
  return known.length === 0
    ? WorkspaceNotFoundForCallerRead(workspaceId)
    : WorkspaceNotFoundForCallerReadKnown(workspaceId, known)
}

export class WorkspaceNotFoundForCallerError extends Error {
  constructor(
    readonly workspaceId: string,
    intent: WorkspaceNotFoundIntent = 'read',
    known: readonly string[] = [],
  ) {
    super(workspaceNotFoundMessage(workspaceId, intent, known))
    this.name = 'WorkspaceNotFoundForCallerError'
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
 */
export class WorkspaceSegmentUnusableError extends Error {
  constructor(readonly handle: string) {
    super(WorkspaceSegmentUnusable(handle))
    this.name = 'WorkspaceSegmentUnusableError'
  }
}

/**
 * A document has ONE display name, and `wb_workspace_edit`'s `document.create`
 * can be handed it twice: as `name` and as the OKF `title` of its body. They
 * land in the same place (the workspace's name for the document), so a pair
 * that disagrees has no right answer a server could pick — whichever won
 * would be a silent choice about what the caller meant.
 */
export class DocumentNameConflictError extends Error {
  constructor(
    readonly given: string,
    readonly title: string,
  ) {
    super(DocumentNameConflict(given, title))
    this.name = 'DocumentNameConflictError'
  }
}
