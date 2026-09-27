import {
  type DocumentContainers,
  MARKDOWN_BODY_KEY,
  writeMarkdownBody,
} from '@kamiazya/whiteboard-loro-adapter'
import type { LoroDoc, LoroText } from 'loro-crdt'

/**
 * What a CodeMirror binding writes a sync session's body through: the live
 * doc, the body text on it, and the session's debounced commit.
 */
export interface BodyBinding {
  readonly doc: LoroDoc
  readonly readText: (doc: LoroDoc) => LoroText
  readonly commit: () => void
  /** Writes a pre-unification body into the container; see `loroTextSync`'s `adoptInitial`. */
  readonly adopt: (text: string) => void
}

/**
 * One `BodyBinding` per doc, rebuilt only when the session's doc is replaced
 * by a snapshot — so an editor keyed on it remounts exactly then, and not on
 * every body change. `onEdited` is told WHICH doc the ops went into, and
 * `isCurrent` answers for a doc a snapshot may have replaced, so the session
 * never commits or converts a doc it no longer holds.
 */
export function bodyBindingFor(deps: {
  contentOf: (doc: LoroDoc) => DocumentContainers
  onEdited: (doc: LoroDoc) => void
  isCurrent: (doc: LoroDoc) => boolean
}): (doc: LoroDoc | null) => BodyBinding | null {
  const readText = (doc: LoroDoc) => deps.contentOf(doc).getText(MARKDOWN_BODY_KEY)
  let cached: BodyBinding | null = null
  return (doc) => {
    if (doc === null) return null
    if (cached?.doc !== doc) {
      const bound = doc
      cached = {
        doc: bound,
        readText,
        commit: () => deps.onEdited(bound),
        // `writeMarkdownBody` also clears the canvas, superseding the old
        // `okf-body` node the text came from, so no reader finds a stale
        // second body. It commits at once: the conversion is its own push.
        adopt: (text) => {
          if (deps.isCurrent(bound)) writeMarkdownBody(deps.contentOf(bound), text)
        },
      }
    }
    return cached
  }
}
