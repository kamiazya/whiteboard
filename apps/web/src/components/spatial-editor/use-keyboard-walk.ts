// Tab's walk over the board from the canvas root: each node, then the
// connections and lines that leave it (`traversal-order.ts`). Kept beside the
// keyboard hook rather than inside it because the walk carries one memory of
// its own — which node a connection was reached from, so Escape on it steps
// back there instead of dropping the selection.

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { useRef } from 'react'
import { stepTraversal, traversalStops } from '../../lib/spatial/traversal-order.js'
import type { SelectionEvent } from './selection.js'

export interface KeyboardWalkInputs {
  readonly canvasRef: { readonly current: SpatialCanvas }
  readonly selectedNodeId: string | undefined
  readonly selectedInkIds: readonly string[]
  readonly isLocked: (nodeId: string) => boolean
  readonly isEdgeLocked: (edgeId: string) => boolean
  readonly applySelection: (event: SelectionEvent) => void
  readonly setSelectedInkIds: (ids: readonly string[]) => void
  /** Selects one node and nothing else. */
  readonly selectOnly: (id: string) => void
}

export function useKeyboardWalk(inputs: KeyboardWalkInputs) {
  const { canvasRef, selectedNodeId, isLocked, selectOnly } = inputs
  const anchorRef = useRef<{ inkId: string; nodeId: string } | null>(null)
  const soleInk = inputs.selectedInkIds.length === 1 ? inputs.selectedInkIds[0] : undefined

  /** One step of the walk; false when it steps off either end, so Tab can leave. */
  const step = (direction: 1 | -1): boolean => {
    const current =
      selectedNodeId !== undefined
        ? { kind: 'node' as const, id: selectedNodeId }
        : soleInk === undefined
          ? null
          : { kind: 'ink' as const, id: soleInk }
    const stops = traversalStops(canvasRef.current, {
      isNodeLocked: isLocked,
      isInkLocked: inputs.isEdgeLocked,
    })
    const next = stepTraversal(stops, current, direction)
    if (next === undefined) return false
    if (next.kind === 'node') {
      selectOnly(next.id)
      return true
    }
    inputs.applySelection({ type: 'clear' })
    inputs.setSelectedInkIds([next.id])
    anchorRef.current = next.anchorId === null ? null : { inkId: next.id, nodeId: next.anchorId }
    return true
  }

  /**
   * Escape on the connection the walk last reached: back to its node, when
   * that node can still be selected. False for any other ink selection, which
   * Escape simply clears.
   */
  const stepBack = (): boolean => {
    const anchor = anchorRef.current
    anchorRef.current = null
    if (anchor === null || selectedNodeId !== undefined || soleInk !== anchor.inkId) return false
    const node = canvasRef.current.nodes.find((entry) => entry.id === anchor.nodeId)
    if (node === undefined || isLocked(node.id)) return false
    selectOnly(node.id)
    return true
  }

  return { step, stepBack }
}
