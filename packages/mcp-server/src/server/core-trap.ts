import {
  CoreHandleLost,
  CoreInstanceTrapped,
  CoreUnrecoverable,
} from '@kamiazya/whiteboard-core-wasm'
import { DocumentEngineTrapError } from '@kamiazya/whiteboard-server-core'

/**
 * Names an abort of the Rust core as `DocumentEngineTrapError`, the one
 * refusal (`document_engine_trap`, 500) every surface answers an engine abort
 * with. The core's own classes cannot be matched in server-core, which may not
 * import the shim, so the root that loads the core supplies this.
 *
 * `CoreHandleLost` is the same refusal: it means a handle outlived a reset,
 * which its owner normally rebuilds from before the error can surface, so one
 * that reaches a caller is the daemon's own fault and not an input to fix.
 */
export function coreTrapAsEngineTrap(err: unknown): DocumentEngineTrapError | undefined {
  if (
    err instanceof CoreInstanceTrapped ||
    err instanceof CoreHandleLost ||
    err instanceof CoreUnrecoverable
  ) {
    return new DocumentEngineTrapError(
      err.operation,
      'running',
      err,
      !(err instanceof CoreUnrecoverable),
    )
  }
  return undefined
}
