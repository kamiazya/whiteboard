import { type DocumentContainers, MARKDOWN_BODY_KEY } from '@kamiazya/whiteboard-loro-adapter'
import type { LoroDoc, LoroText } from 'loro-crdt'

/**
 * What a CodeMirror binding writes a sync session's body through: the live
 * doc, the body text on it, and the session's debounced commit.
 */
export interface BodyBinding {
  readonly doc: LoroDoc
  /** Null once the document has left the workspace record. */
  readonly readText: (doc: LoroDoc) => LoroText | null
  readonly commit: () => void
}

/**
 * One `BodyBinding` per doc, rebuilt only when the session's doc is replaced
 * by a snapshot — so an editor keyed on it remounts exactly then, and not on
 * every body change. `onEdited` is told WHICH doc the ops went into, so the
 * session never commits a doc a snapshot has replaced.
 */
export function bodyBindingFor(deps: {
  contentOf: (doc: LoroDoc) => DocumentContainers | null
  onEdited: (doc: LoroDoc) => void
}): (doc: LoroDoc | null) => BodyBinding | null {
  const readText = (doc: LoroDoc) => deps.contentOf(doc)?.getText(MARKDOWN_BODY_KEY) ?? null
  let cached: BodyBinding | null = null
  return (doc) => {
    if (doc === null) return null
    if (cached?.doc !== doc) {
      const bound = doc
      cached = {
        doc: bound,
        readText,
        commit: () => deps.onEdited(bound),
      }
    }
    return cached
  }
}
