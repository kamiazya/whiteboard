import type { BodyDocPort, BodyTextPort } from './body-text-port.js'

/**
 * What a CodeMirror binding writes a sync session's body through: the live
 * doc, the body text on it, and the session's debounced commit.
 */
export interface BodyBinding<
  D extends BodyDocPort = BodyDocPort,
  T extends BodyTextPort = BodyTextPort,
> {
  readonly doc: D
  /**
   * Null once the document has left the workspace record. A method rather
   * than a property so a binding over a concrete doc stays assignable to the
   * port-typed one the consumers hold.
   */
  readText(doc: D): T | null
  readonly commit: () => void
}

/**
 * One `BodyBinding` per doc, rebuilt only when the session's doc is replaced
 * by a snapshot — so an editor keyed on it remounts exactly then, and not on
 * every body change. `onEdited` is told WHICH doc the ops went into, so the
 * session never commits a doc a snapshot has replaced.
 */
export function bodyBindingFor<D extends BodyDocPort, T extends BodyTextPort>(deps: {
  readText: (doc: D) => T | null
  onEdited: (doc: D) => void
}): (doc: D | null) => BodyBinding<D, T> | null {
  const { readText } = deps
  let cached: BodyBinding<D, T> | null = null
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
