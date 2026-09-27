import type { LoroDoc, LoroText } from 'loro-crdt'

/**
 * What a CodeMirror binding writes a sync session's body through: the live
 * doc, the body text on it, and the session's debounced commit.
 */
export interface BodyBinding {
  readonly doc: LoroDoc
  readonly readText: (doc: LoroDoc) => LoroText
  readonly commit: () => void
}

/**
 * One `BodyBinding` per doc, rebuilt only when the session's doc is replaced
 * by a snapshot — so an editor keyed on it remounts exactly then, and not on
 * every body change. `onEdited` is told WHICH doc the ops went into, so the
 * session can refuse to commit a doc it no longer holds.
 */
export function bodyBindingFor(
  readText: (doc: LoroDoc) => LoroText,
  onEdited: (doc: LoroDoc) => void,
): (doc: LoroDoc | null) => BodyBinding | null {
  let cached: BodyBinding | null = null
  return (doc) => {
    if (doc === null) return null
    if (cached?.doc !== doc) {
      const bound = doc
      cached = { doc: bound, readText, commit: () => onEdited(bound) }
    }
    return cached
  }
}
