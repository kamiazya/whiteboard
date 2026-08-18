import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { useState } from 'react'
import type { EditorCommand } from '../spatial-editor/commands.js'
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
 */
export function useNodeInEditor(
  canvas: SpatialCanvas,
  onChange: (next: SpatialCanvas, command: EditorCommand) => void,
): NodeInEditor {
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
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
