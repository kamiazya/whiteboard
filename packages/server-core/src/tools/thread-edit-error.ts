import {
  REFUSAL_CODE_THREAD_EDIT_OP_REFUSED,
  ThreadEditOpRefused,
} from '@kamiazya/whiteboard-model'

/**
 * "Nothing was written" is literal here, not a formula copied from
 * `wb_canvas_edit`: the ops gather their writes, which reach the document's
 * working copy only after the last op has passed, and the snapshot is saved
 * once after that. A throw leaves the stored document exactly as it was.
 */
export class ThreadEditError extends Error {
  readonly code = REFUSAL_CODE_THREAD_EDIT_OP_REFUSED

  constructor(
    readonly opIndex: number,
    readonly op: string,
    detail: string,
  ) {
    super(ThreadEditOpRefused(opIndex, op, detail))
    this.name = 'ThreadEditError'
  }
}
