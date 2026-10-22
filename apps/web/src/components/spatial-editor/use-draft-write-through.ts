import { nodeText, type SpatialNode } from '@kamiazya/whiteboard-model'
import { useEffect, useRef } from 'react'
import type { EditorCommand } from '../../lib/spatial/commands.js'
import type { GestureResult, GestureState } from './gestures.js'

/**
 * How long typing may pause before the draft is written to the document. A
 * reload or a closed tab cannot wait for an asynchronous save, so the stored
 * document has to hold the text before then.
 */
const DRAFT_WRITE_IDLE_MS = 400

/**
 * Writes an open node editor's draft to the document after a typing pause,
 * without closing the edit: the gesture stays `editing-text` (the draft as its
 * pending text) and only the document learns the text.
 *
 * `cancelCommands` is what ending the edit by cancel must add: an existing
 * node already took the draft, and cancelling reverts the edit rather than
 * keeping it. A node created for the edit is left to the reducer's own rule.
 */
export function useDraftWriteThrough(
  node: SpatialNode,
  gestureState: GestureState,
  applyResult: (result: GestureResult) => void,
) {
  const latest = useRef({ gestureState, applyResult })
  latest.current = { gestureState, applyResult }
  const before = useRef(nodeText(node) ?? '')
  const idleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const written = useRef(false)
  useEffect(() => () => clearTimeout(idleTimer.current), [])

  return {
    schedule(text: string) {
      clearTimeout(idleTimer.current)
      idleTimer.current = setTimeout(() => {
        const { gestureState: current, applyResult: apply } = latest.current
        if (current.kind !== 'editing-text') return
        written.current = true
        apply({
          state: { ...current, pendingText: text },
          commands: [{ kind: 'set-text', id: node.id, text }],
        })
      }, DRAFT_WRITE_IDLE_MS)
    },
    stop() {
      clearTimeout(idleTimer.current)
    },
    cancelCommands(): readonly EditorCommand[] | undefined {
      const { gestureState: current } = latest.current
      const revert = written.current && current.kind === 'editing-text' && !current.createdForEdit
      return revert ? [{ kind: 'set-text', id: node.id, text: before.current }] : undefined
    },
  }
}
