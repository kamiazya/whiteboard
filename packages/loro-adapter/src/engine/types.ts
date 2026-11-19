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
  /** Frees the document; every later call naming the handle is refused. */
  close(request: wire.CloseRequest): void
  /**
   * A copy of the document under another peer: its head, or when `at` names
   * frontiers a view at them, which reads and takes no edit.
   */
  fork(request: wire.ForkRequest): wire.OpenResponse
  /**
   * Merges bytes an engine exported; a breach refuses them and changes
   * nothing. The answer says whether the bytes build on operations the
   * document lacks.
   */
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
  /** Applies the runs in order as one commit. */
  textSplice(request: wire.TextSpliceRequest): wire.MutationResult
  /** Places an exported document with everything under it into a workspace record. */
  importSubtree(request: wire.ImportSubtreeRequest): wire.MutationResult
  /** The operations the document holds, as versions and as the bytes a keeper stores. */
  version(request: wire.VersionRequest): wire.VersionResponse
  /** Reads a version or a frontier an engine encoded; no document is needed. */
  decode(request: wire.DecodeRequest): wire.DecodeResponse
  undoState(request: wire.UndoStateRequest): wire.UndoStateResponse
  /** Forgets what an undo or a redo could take back. */
  undoClear(request: wire.UndoClearRequest): void
}
