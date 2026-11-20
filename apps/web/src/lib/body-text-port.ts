/**
 * What the CodeMirror binding needs of a document and of the body text on it,
 * declared structurally so the binding names no CRDT type: a Loro document and
 * text satisfy it as they are, and so does any other holder of a body that can
 * announce a change, splice text and end an edit.
 */
export interface BodyTextPort {
  toString(): string
  insert(index: number, text: string): unknown
  delete(index: number, length: number): unknown
}

export interface BodyDocPort {
  /** The listener is told only that something changed, never what. */
  subscribe(listener: () => void): () => void
  /** Ends the transaction the binding's writes were made in. */
  commit(): unknown
}

/**
 * Reads the text a view is bound to, per operation: the body can move with
 * its document, so a handle is re-resolved rather than held. `null` once the
 * document has left the record.
 */
export type ReadBoundText<D extends BodyDocPort = BodyDocPort> = (doc: D) => BodyTextPort | null
