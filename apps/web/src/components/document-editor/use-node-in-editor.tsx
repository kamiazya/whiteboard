import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { useState } from 'react'
import type { EditorCommand } from '../../lib/spatial/commands.js'
import { withNodeText } from './node-text.js'

export interface NodeInEditor {
  /** Pass to `SpatialEditor`'s `onOpenInEditor`. */
  readonly open: (nodeId: string, text: string) => void
  /** The body being edited, or null when the surface is closed. */
  readonly editing: { readonly id: string; readonly text: string } | null
  /** Pass to the overlay's `onCommit`. */
  readonly commit: (text: string) => void
  /** Pass to the overlay's `onClose`. */
  readonly close: () => void
}

/**
 * The state and the write behind "open in editor", shared by both pages.
 *
 * It exists as one hook rather than two copies because the copies were
 * identical and the prop that carries them is OPTIONAL — a page that stopped
 * wiring it would compile clean and silently lose the feature, and only that
 * page's own test would notice. One hook means one place to get it right.
 *
 * @param documentKey Anything that changes exactly when the document does —
 * the id where a page has one, the addressed path where that is what its own
 * mount is keyed on. REQUIRED rather than optional for the reason above: a
 * caller that forgot it would keep an edit open across a switch and lose
 * what was typed into it, silently.
 */
export function useNodeInEditor(
  canvas: SpatialCanvas,
  onChange: (next: SpatialCanvas, command: EditorCommand) => void,
  documentKey: string | null,
): NodeInEditor {
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  // An open edit belongs to the document it was opened against, and both
  // pages keep their own document switching rather than remounting — so the
  // surface has to be dropped here rather than by a mount boundary.
  //
  // Left standing it is worse than stale: the overlay is full-screen and
  // titles itself from the CURRENT document, so it reads as "Editing <the
  // one you just arrived at>" while holding the other one's node. And
  // `commit` resolves the node in the CURRENT canvas, where it is not
  // found — `withNodeText` answers with the same canvas and the write is
  // dropped as a no-op, so everything typed after the switch is discarded
  // with nothing said.
  //
  // Reset during RENDER rather than in an effect, the same shape
  // `DerivedFacetForm` uses for its draft: an effect would let the surface
  // paint once under the new document's name before it goes.
  const [scope, setScope] = useState(documentKey)
  if (scope !== documentKey) {
    setScope(documentKey)
    setEditing(null)
  }
  return {
    editing,
    open: (id, text) => setEditing({ id, text }),
    commit: (text) => {
      if (editing === null) return
      const next = withNodeText(canvas, editing.id, text)
      // Same canvas back means nothing changed that could be written — no
      // revision for a no-op.
      if (next === canvas) return
      onChange(next, { kind: 'set-text', id: editing.id, text })
    },
    close: () => setEditing(null),
  }
}
