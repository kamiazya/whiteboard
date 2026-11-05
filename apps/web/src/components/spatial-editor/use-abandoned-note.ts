import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { type MutableRefObject, useLayoutEffect, useRef } from 'react'
import { applyCommand, type EditorCommand } from '../../lib/spatial/commands.js'
import type { GestureState } from './gestures.js'

/**
 * Removes a note made for an edit that is still empty when the editor goes
 * away — leaving the page, or switching documents, mid-edit. Escape already
 * removes one; leaving ended the edit with no Escape, so the empty box stayed
 * in the document and in its export.
 *
 * A LAYOUT effect's cleanup, so it runs while the page around the editor is
 * still mounted and its `onChange` still writes somewhere.
 */
export function useRemoveAbandonedNote({
  gestureStateRef,
  canvasRef,
  onChange,
}: {
  readonly gestureStateRef: MutableRefObject<GestureState>
  readonly canvasRef: MutableRefObject<SpatialCanvas>
  readonly onChange: (canvas: SpatialCanvas, command: EditorCommand) => void
}): void {
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  useLayoutEffect(
    () => () => {
      const state = gestureStateRef.current
      if (state.kind !== 'editing-text' || state.createdForEdit !== true) return
      if (state.pendingText !== '') return
      const command: EditorCommand = { kind: 'delete-node', id: state.nodeId }
      onChangeRef.current(applyCommand(canvasRef.current, command), command)
    },
    [gestureStateRef, canvasRef],
  )
}
