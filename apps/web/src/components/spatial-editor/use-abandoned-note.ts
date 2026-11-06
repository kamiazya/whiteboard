import { nodeText, type SpatialCanvas } from '@kamiazya/whiteboard-model'
import { type MutableRefObject, useEffect, useLayoutEffect, useRef } from 'react'
import { applyCommand, type EditorCommand } from '../../lib/spatial/commands.js'
import {
  forgetUnsavedNote,
  readUnsavedNotes,
  rememberUnsavedNote,
} from '../../lib/spatial/unsaved-notes.js'
import type { GestureState } from './gestures.js'

/** The note an edit was opened on a fresh note for, or undefined. */
function newNoteUnderEdit(state: GestureState): string | undefined {
  return state.kind === 'editing-text' && state.createdForEdit === true ? state.nodeId : undefined
}

/**
 * Removes a note made for an edit that is still empty when the editor goes
 * away — leaving the page, or switching documents, mid-edit. Escape already
 * removes one; leaving ended the edit with no Escape, so the empty box stayed
 * in the document and in its export.
 *
 * A LAYOUT effect's cleanup, so it runs while the page around the editor is
 * still mounted and its `onChange` still writes somewhere.
 *
 * A page closed or reloaded runs no cleanup at all, so while such an edit is
 * open its note is also remembered for the tab (`unsaved-notes`), and the
 * next editor on the same document removes it if it is still there and still
 * empty. A note somebody typed into since is only forgotten.
 */
export function useRemoveAbandonedNote({
  gestureState,
  gestureStateRef,
  canvas,
  canvasRef,
  onChange,
  documentKey,
}: {
  readonly gestureState: GestureState
  readonly gestureStateRef: MutableRefObject<GestureState>
  readonly canvas: SpatialCanvas
  readonly canvasRef: MutableRefObject<SpatialCanvas>
  readonly onChange: (canvas: SpatialCanvas, command: EditorCommand) => void
  /** Names the document; without one nothing outlives the page. */
  readonly documentKey: string | undefined
}): void {
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const documentKeyRef = useRef(documentKey)
  documentKeyRef.current = documentKey

  useLayoutEffect(
    () => () => {
      const state = gestureStateRef.current
      const id = newNoteUnderEdit(state)
      if (id === undefined || state.kind !== 'editing-text' || state.pendingText !== '') return
      const command: EditorCommand = { kind: 'delete-node', id }
      onChangeRef.current(applyCommand(canvasRef.current, command), command)
      if (documentKeyRef.current !== undefined) forgetUnsavedNote(documentKeyRef.current, id)
    },
    [gestureStateRef, canvasRef],
  )

  // What the last page left behind, read once: notes this editor goes on to
  // make are remembered under the same key and must not be swept.
  const leftBehind = useRef<readonly string[] | null>(null)
  if (leftBehind.current === null)
    leftBehind.current = documentKey === undefined ? [] : readUnsavedNotes(documentKey)

  useEffect(() => {
    const pending = leftBehind.current ?? []
    if (documentKey === undefined || pending.length === 0) return
    const settled: string[] = []
    let next = canvas
    for (const id of pending) {
      const node = next.nodes.find((candidate) => candidate.id === id)
      // Not loaded yet, or never written: wait for it rather than forget it.
      if (node === undefined) continue
      settled.push(id)
      forgetUnsavedNote(documentKey, id)
      if (nodeText(node) !== '') continue
      const command: EditorCommand = { kind: 'delete-node', id }
      next = applyCommand(next, command)
      onChangeRef.current(next, command)
    }
    leftBehind.current = pending.filter((id) => !settled.includes(id))
  }, [canvas, documentKey])

  const editedId = newNoteUnderEdit(gestureState)
  useEffect(() => {
    if (editedId === undefined || documentKey === undefined) return
    rememberUnsavedNote(documentKey, editedId)
    return () => forgetUnsavedNote(documentKey, editedId)
  }, [editedId, documentKey])
}
