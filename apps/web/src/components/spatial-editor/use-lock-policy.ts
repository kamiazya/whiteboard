// The lock seams and their coherence, extracted from SpatialEditor: whether
// a lock binds at all (host wired the callback), the per-id predicates, the
// selectable subset, and the two effects that retire state a lock arrival
// invalidates. Everything downstream (hit-testing, drag layers, snapping,
// keyboard verbs) consumes the returned predicates, so lock policy has one
// definition.

import { useEffect, useMemo } from 'react'
import type { NodeBox } from '../../lib/spatial/geometry.js'
import { createIdleState, type GestureState } from './gestures.js'
import type { SelectionEvent } from './selection.js'

export interface LockPolicyInputs {
  boxes: readonly NodeBox[]
  lockedNodeIds: ReadonlySet<string> | undefined
  lockedEdgeIds: ReadonlySet<string> | undefined
  onToggleNodeLock: ((nodeId: string, locked: boolean) => void) | undefined
  onToggleEdgeLock: ((edgeId: string, locked: boolean) => void) | undefined
  selectedId: string | null
  extraIds: ReadonlySet<string>
  selectedEdgeId: string | null
  setSelectedEdgeId: (id: string | null) => void
  setEdgeLabelEditId: (update: (current: string | null) => string | null) => void
  gestureState: GestureState
  setGestureState: (state: GestureState) => void
  applySelection: (event: SelectionEvent) => void
}

export function useLockPolicy({
  boxes,
  lockedNodeIds,
  lockedEdgeIds,
  onToggleNodeLock,
  onToggleEdgeLock,
  selectedId,
  extraIds,
  selectedEdgeId,
  setSelectedEdgeId,
  setEdgeLabelEditId,
  gestureState,
  setGestureState,
  applySelection,
}: LockPolicyInputs) {
  /**
   * Lock only binds when the host wired the seam — an editor mounted
   * without `onToggleNodeLock` has no way to unlock, so blocking there
   * would strand the node.
   */
  const lockEnabled = onToggleNodeLock !== undefined
  const isLocked = (nodeId: string): boolean => lockEnabled && (lockedNodeIds?.has(nodeId) ?? false)
  /** Boxes a pointer or marquee may target: locked nodes are invisible to both. */
  const selectableBoxes = useMemo(
    () => (lockEnabled ? boxes.filter((entry) => !isLocked(entry.id)) : boxes),
    // isLocked closes over lockedNodeIds/lockEnabled, both listed here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [boxes, lockEnabled, lockedNodeIds],
  )
  /** Same seam rule as the node lock: no callback, no enforcement. */
  const edgeLockEnabled = onToggleEdgeLock !== undefined
  const isEdgeLocked = (edgeId: string): boolean =>
    edgeLockEnabled && (lockedEdgeIds?.has(edgeId) ?? false)

  /**
   * A lock can arrive from a peer or an agent while the node is ALREADY
   * selected or mid-drag — a case hit-test filtering cannot reach, because
   * the selection exists before the lock does. Dropping it here closes
   * every command path that reads the selection (nudge, delete, resize,
   * z-order, colour, cut) at one point instead of guarding each in turn.
   * A locked primary promotes the first surviving extra rather than
   * clearing the whole selection, so locking one node of many is not a
   * silent deselect-all.
   */
  useEffect(() => {
    if (edgeLockEnabled && selectedEdgeId !== null && isEdgeLocked(selectedEdgeId)) {
      setSelectedEdgeId(null)
      setEdgeLabelEditId((current) => (current === selectedEdgeId ? null : current))
    }
    // isEdgeLocked closes over lockedEdgeIds/edgeLockEnabled, both listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edgeLockEnabled, lockedEdgeIds, selectedEdgeId])

  useEffect(() => {
    if (!lockEnabled) return
    if (gestureState.kind === 'moving' || gestureState.kind === 'resizing') {
      if (isLocked(gestureState.nodeId)) setGestureState(createIdleState())
    }
    const lockedMembers = new Set(
      [...extraIds, ...(selectedId !== null ? [selectedId] : [])].filter(isLocked),
    )
    if (lockedMembers.size > 0) applySelection({ type: 'drop-locked', lockedIds: lockedMembers })
    // isLocked closes over lockedNodeIds/lockEnabled, both listed here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lockEnabled, lockedNodeIds, selectedId, extraIds, gestureState])

  return { lockEnabled, isLocked, selectableBoxes, edgeLockEnabled, isEdgeLocked }
}
