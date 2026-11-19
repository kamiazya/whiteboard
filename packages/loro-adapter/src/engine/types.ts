/**
 * The CRDT document engine's port: the calls of
 * `contracts/crdt/document-engine.schema.json`, as one object. Every request
 * and response is the contract's own type, so the TypeScript engine and the
 * Rust one are two implementations of one wire.
 *
 * Only `read` is asynchronous: one read asks the keeper's files, and a caller
 * that awaits every call is indifferent to which engine answers.
 */
import type { documentEngine as wire } from '@kamiazya/whiteboard-model'

export interface CrdtEngine {
  open(request: wire.OpenRequest): wire.OpenResponse
  /** Merges bytes an engine exported; a breach refuses them and changes nothing. */
  import(request: wire.ImportRequest): wire.MutationResult
  export(request: wire.ExportRequest): wire.ExportResponse
  /**
   * Applies the batch as one commit. A writer that throws, or a local update
   * that breaks a sync limit, leaves the document as it was: the throw reaches
   * the caller, a breach comes back in the result.
   */
  write(request: wire.WriteRequest): wire.MutationResult
  read(request: wire.ReadRequest): Promise<wire.ReadResponse>
  undo(request: wire.UndoRequest): wire.MutationResult
  redo(request: wire.RedoRequest): wire.MutationResult
  textSplice(request: wire.TextSpliceRequest): wire.MutationResult
}
