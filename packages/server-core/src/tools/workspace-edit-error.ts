import {
  DocumentMoveNeedsTarget,
  describeThrown,
  REFUSAL_CODE_DOCUMENT_MOVE_NEEDS_TARGET,
  REFUSAL_CODE_WORKSPACE_EDIT_OP_REFUSED,
  WorkspaceEditOpRefused,
} from '@kamiazya/whiteboard-model'

/** A `document.move` that names neither where to move nor what to rename to. */
export class DocumentMoveNeedsTargetError extends Error {
  readonly code = REFUSAL_CODE_DOCUMENT_MOVE_NEEDS_TARGET

  constructor() {
    super(DocumentMoveNeedsTarget())
    this.name = 'DocumentMoveNeedsTargetError'
  }
}

/**
 * Thrown when one op in a batch cannot apply.
 *
 * Deliberately NOT `wb_canvas_edit`'s "Nothing was written". That tool edits
 * ONE document, so its whole batch is one load and one save and it can
 * honestly promise all-or-nothing. A workspace batch spans documents, and
 * each document is its own Loro doc with its own snapshot — so the ops
 * before the failure have already been saved and there is no transaction to
 * roll them back. Claiming otherwise would be a lie a caller acts on: they
 * would retry the whole batch and create the first documents twice.
 *
 * A `detail` that already ends in a full stop (an index's refusal reads as a
 * sentence) is joined without doubling it.
 *
 * `opIndex` and the applied count are in the MESSAGE as well as on the
 * class, because only `.message` survives the MCP error path and a caller
 * repairing a rejected batch needs to know where to resume.
 */
export class WorkspaceEditError extends Error {
  readonly code = REFUSAL_CODE_WORKSPACE_EDIT_OP_REFUSED

  constructor(
    readonly opIndex: number,
    readonly op: string,
    readonly applied: number,
    cause: unknown,
  ) {
    super(
      WorkspaceEditOpRefused(opIndex, op, describeThrown(cause).replace(/\.$/, ''), applied),
      // Kept so a surface that must not quote a fault can see what it quotes.
      { cause },
    )
    this.name = 'WorkspaceEditError'
  }
}
