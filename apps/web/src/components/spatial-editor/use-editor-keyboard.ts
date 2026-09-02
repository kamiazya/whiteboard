// The editor's keyboard surface, extracted from SpatialEditor as one hook:
// the declarative shortcut dispatch (shortcuts.ts stays the single catalog)
// and the three keydown handlers the JSX wires — the canvas root's, the
// focused resize handle's, and the connect handle's. Everything here
// CONSUMES the editor's state and appliers; it owns no React state of its
// own, so a keyboard behavior can never disagree with the pointer path
// about whose state is authoritative.

import type { SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import type { EditorCommand } from './commands.js'
import { applyCommand } from './commands.js'
import {
  type Box,
  type ResizeHandleKind,
  resizeBoxByDelta,
  scaleBoxWithin,
  unionBox,
} from './geometry.js'
import { type GestureResult, type GestureState, reduceGesture } from './gestures.js'
import type { SelectionEvent } from './selection.js'
import { findShortcut, type ShortcutId } from './shortcuts.js'
import type { EditorTool } from './ToolPalette.js'

/** One keyboard step of zoom — finer than the double press, which jumps. */
const STEP_ZOOM_FACTOR = 1.25
/** Canvas-space px per arrow-key nudge on a focused resize handle; Shift multiplies by 4. */
const RESIZE_KEYBOARD_STEP = 8
const RESIZE_KEYBOARD_STEP_LARGE = 32
const ARROW_KEY_DELTA: Record<string, { dx: number; dy: number }> = {
  ArrowLeft: { dx: -1, dy: 0 },
  ArrowRight: { dx: 1, dy: 0 },
  ArrowUp: { dx: 0, dy: -1 },
  ArrowDown: { dx: 0, dy: 1 },
}

export interface EditorKeyboardInputs {
  tool: EditorTool
  canvas: SpatialCanvas
  /** The live canvas mirror the auto-repeat paths read and write back. */
  canvasRef: { current: SpatialCanvas }
  gestureState: GestureState
  selection: { id: string; box: Box } | undefined
  selectedNode: SpatialNode | undefined
  extraIds: ReadonlySet<string>
  selectedEdgeId: string | null
  setSelectedEdgeId: (id: string | null) => void
  pendingCut: object | null
  setPendingCut: (next: null) => void
  spaceDownRef: { current: boolean }
  lockEnabled: boolean
  edgeLockEnabled: boolean
  isLocked: (nodeId: string) => boolean
  isEdgeLocked: (edgeId: string) => boolean
  onToggleNodeLock: ((nodeId: string, locked: boolean) => void) | undefined
  onToggleEdgeLock: ((edgeId: string, locked: boolean) => void) | undefined
  onChange: (next: SpatialCanvas, command: EditorCommand) => void
  applyResult: (result: GestureResult) => void
  applySelection: (event: SelectionEvent) => void
  duplicateSelection: () => boolean
  reorderSelection: (placement: 'forward' | 'backward' | 'front' | 'back') => boolean
  stepZoom: (factor: number) => boolean
  frameContent: () => boolean
  frameSelection: () => boolean
}

export function useEditorKeyboard({
  tool,
  canvas,
  canvasRef,
  gestureState,
  selection,
  selectedNode,
  extraIds,
  selectedEdgeId,
  setSelectedEdgeId,
  pendingCut,
  setPendingCut,
  spaceDownRef,
  lockEnabled,
  edgeLockEnabled,
  isLocked,
  isEdgeLocked,
  onToggleNodeLock,
  onToggleEdgeLock,
  onChange,
  applyResult,
  applySelection,
  duplicateSelection,
  reorderSelection,
  stepZoom,
  frameContent,
  frameSelection,
}: EditorKeyboardInputs) {
  const selectAllNodes = (): boolean => {
    const allIds = canvasRef.current.nodes.map((node) => node.id).filter((id) => !isLocked(id))
    if (allIds.length === 0) return true
    applySelection({ type: 'set-members', ids: allIds })
    setSelectedEdgeId(null)
    return true
  }

  /**
   * Toggle the lock on the current selection. Lock is host state, so
   * this reports through the callback and never touches the canvas
   * value — a lock is not an edit to the document.
   */
  const toggleSelectionLock = (): boolean => {
    // An edge selection is exclusive with a node selection, so this is a
    // dispatch, not a merge.
    if (edgeLockEnabled && selectedEdgeId !== null) {
      onToggleEdgeLock?.(selectedEdgeId, !isEdgeLocked(selectedEdgeId))
      return true
    }
    if (!lockEnabled || onToggleNodeLock === undefined || selection === undefined) return false
    const ids = [selection.id, ...extraIds]
    // The primary's current state decides the direction, so a mixed
    // selection lands on ONE state instead of flipping each node.
    const next = !isLocked(selection.id)
    for (const id of ids) onToggleNodeLock(id, next)
    if (next) {
      applySelection({ type: 'clear' })
    }
    return true
  }

  /** Table-dispatched shortcut handlers, keyed by the catalog's ids. */
  const runShortcut = (id: ShortcutId): boolean => {
    switch (id) {
      case 'toggle-lock':
        return toggleSelectionLock()
      case 'zoom-in':
        return stepZoom(STEP_ZOOM_FACTOR)
      case 'zoom-out':
        return stepZoom(1 / STEP_ZOOM_FACTOR)
      case 'zoom-to-fit':
        return frameContent()
      case 'zoom-to-selection':
        return frameSelection()
      case 'select-all':
        return selectAllNodes()
      case 'duplicate-selection':
        return duplicateSelection()
      case 'reorder-forward':
        return reorderSelection('forward')
      case 'reorder-backward':
        return reorderSelection('backward')
      case 'reorder-front':
        return reorderSelection('front')
      case 'reorder-back':
        return reorderSelection('back')
      default:
        // Inline-handled ids never reach here (findShortcut skips them).
        return false
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // Declarative shortcuts first — see shortcuts.ts, the single catalog.
    const shortcut = findShortcut(e.nativeEvent, tool)
    if (shortcut !== undefined && runShortcut(shortcut.id)) {
      e.preventDefault()
      return
    }
    // Keyboard equivalent of pointercancel: discards an in-flight
    // resize/move/connect gesture without committing it.
    if (e.key === 'Escape' && selectedEdgeId !== null) {
      e.preventDefault()
      setSelectedEdgeId(null)
      return
    }
    if (
      (e.key === 'Delete' || e.key === 'Backspace') &&
      selectedEdgeId !== null &&
      gestureState.kind !== 'editing-text'
    ) {
      const target = e.target as HTMLElement | null
      const tag = target?.tagName
      if (tag !== 'INPUT' && tag !== 'TEXTAREA' && !target?.isContentEditable) {
        e.preventDefault()
        applyResult({
          state: { kind: 'idle' },
          commands: [{ kind: 'delete-edge', id: selectedEdgeId } as const],
        })
        setSelectedEdgeId(null)
        return
      }
    }
    if (e.key === 'Escape' && gestureState.kind === 'idle' && pendingCut !== null) {
      e.preventDefault()
      // Escape lifts only the HOLD. The envelope stays: the clipboard
      // keeps working as a plain copy, matching what the OS side already
      // holds (which no Escape of ours could clear).
      setPendingCut(null)
      return
    }
    if (e.key === 'Escape' && gestureState.kind !== 'idle') {
      e.preventDefault()
      // Escape is the PERSON's cancel, not the platform's: it routes to
      // cancel-text-edit, whose empty-note branch keeps a freshly placed
      // box. pointercancel is reserved for genuine gesture teardown (see
      // the lost-capture handling), where the half-made node is debris.
      // For every non-editing gesture the two arms behave identically.
      applyResult(reduceGesture(gestureState, canvas, { type: 'cancel-text-edit' }))
      return
    }
    // Delete/Backspace deletes the current selection — but never while the
    // event's own target is a text-entry surface (the open TextNodeEditor's
    // textarea, or any other input this root might contain), or Backspace
    // while typing would delete the node instead of a character. The
    // reducer's own editing-text guard is the second, machine-checkable
    // layer of that same policy (see gestures.ts's delete-selection arm).
    // Arrow keys nudge the SELECTED node (standard canvas-tool parity);
    // Shift multiplies the step. A focused resize handle handles arrows
    // itself and stops propagation there, so an arrow reaching THIS
    // handler is never a resize.
    if (e.key === ' ' && gestureState.kind === 'idle') {
      // Held Space turns the next left-drag into a pan (Excalidraw
      // semantics). preventDefault stops the page scrolling on Space —
      // but never while the key originates in a text-entry surface. Node
      // text editing is covered by the gesture-state check (editing-text
      // is not idle); the edge label editor keeps the gesture idle, so a
      // typed space would otherwise be swallowed here.
      const target = e.target as HTMLElement | null
      const tag = target?.tagName
      if (tag !== 'INPUT' && tag !== 'TEXTAREA' && !target?.isContentEditable) {
        e.preventDefault()
        spaceDownRef.current = true
      }
      return
    }
    const nudge = ARROW_KEY_DELTA[e.key]
    if (
      nudge !== undefined &&
      selection !== undefined &&
      selectedNode !== undefined &&
      gestureState.kind === 'idle'
    ) {
      e.preventDefault()
      const step = e.shiftKey ? RESIZE_KEYBOARD_STEP_LARGE : RESIZE_KEYBOARD_STEP
      // Nudge the WHOLE selection, not just the primary: a multi-selection
      // that tore apart under the arrow keys was a latent bug select-all
      // makes trivial to hit. Positions are read from canvasRef, not the
      // render closure — key auto-repeat delivers keydowns faster than
      // commits re-render, and a stale base clobbers the previous nudge.
      const ids = [selectedNode.id, ...extraIds]
      const moves = ids.flatMap((id) => {
        const current = canvasRef.current.nodes.find((n) => n.id === id)
        if (current === undefined) return []
        return [
          {
            kind: 'move-node' as const,
            id: current.id,
            x: current.x + nudge.dx * step,
            y: current.y + nudge.dy * step,
          },
        ]
      })
      if (moves.length === 0) return
      // ONE batch, not N commands: a multi-node nudge is one user action
      // and must undo as one step (N separate commits would only group by
      // the UndoManager's merge-timing heuristic).
      applyResult({ state: gestureState, commands: [{ kind: 'batch', commands: moves }] })
      return
    }
    if (
      (e.key === 'Delete' || e.key === 'Backspace') &&
      selection !== undefined &&
      extraIds.size > 0 &&
      gestureState.kind !== 'editing-text'
    ) {
      e.preventDefault()
      const ids = [selection.id, ...extraIds]
      applyResult({
        state: { kind: 'idle' },
        commands: ids.map((id) => ({ kind: 'delete-node' as const, id })),
        selectedId: null,
      })
      return
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selection !== undefined) {
      const target = e.target as HTMLElement | null
      const tag = target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return
      e.preventDefault()
      applyResult(
        reduceGesture(gestureState, canvas, { type: 'delete-selection', nodeId: selection.id }),
      )
    }
  }

  const handleResizeHandleKeyDown = (
    handle: ResizeHandleKind,
    _handleBox: Box,
    e: React.KeyboardEvent,
  ) => {
    if (selection === undefined) return
    // Geometry comes from `canvasRef`, not from the render snapshot the
    // pointer path can afford to use. Key repeat delivers the next press
    // before React has re-rendered, and a parent that applies `onChange`
    // asynchronously lags further still — reading the stale snapshot would
    // make every press compute the same coordinates, so holding the key
    // would resize once and then appear to stick.
    const members = [selection.id, ...extraIds].flatMap((id) => {
      const node = canvasRef.current.nodes.find((candidate) => candidate.id === id)
      return node === undefined
        ? []
        : [{ id, box: { x: node.x, y: node.y, width: node.width, height: node.height } }]
    })
    // The resize anchor is the box the HANDLES surround, not the handle's
    // own tiny hit-box `_handleBox` describes — same reasoning as
    // onHandlePointerDown's `box: selectionBox` in the editor's JSX.
    const box = unionBox(members.map((member) => member.box))
    if (box === undefined) return
    const step = e.shiftKey ? RESIZE_KEYBOARD_STEP_LARGE : RESIZE_KEYBOARD_STEP
    const delta = ARROW_KEY_DELTA[e.key]
    if (delta === undefined) return
    e.preventDefault()
    const nextBox = resizeBoxByDelta(box, handle, delta.dx * step, delta.dy * step)
    if (
      nextBox.x === box.x &&
      nextBox.y === box.y &&
      nextBox.width === box.width &&
      nextBox.height === box.height
    ) {
      return
    }
    // Same handles, same meaning as the pointer drag: a lone node takes the
    // dragged box verbatim, a selection has each member re-placed inside it.
    const commands: readonly EditorCommand[] =
      members.length > 1
        ? members.map((member) => {
            const scaled = scaleBoxWithin(box, nextBox, member.box)
            return {
              kind: 'resize-node',
              id: member.id,
              x: scaled.x,
              y: scaled.y,
              width: scaled.width,
              height: scaled.height,
            }
          })
        : [
            {
              kind: 'resize-node',
              id: selection.id,
              x: nextBox.x,
              y: nextBox.y,
              width: nextBox.width,
              height: nextBox.height,
            },
          ]
    // Threaded through a running canvas, not re-applied to `canvasRef`
    // each time: the ref does not advance within this tick, so a second
    // command built on it would discard the first.
    let running = canvasRef.current
    for (const command of commands) {
      running = applyCommand(running, command)
      onChange(running, command)
    }
    // Same write-back the gesture path does (see applyResult): without it
    // the ref keeps describing the pre-keypress canvas until the parent's
    // re-render lands.
    canvasRef.current = running
  }

  const handleConnectKeyDown = () => {
    if (selection === undefined) return
    applyResult(
      reduceGesture(gestureState, canvas, { type: 'pointerdown-connect', nodeId: selection.id }),
    )
  }

  return { handleKeyDown, handleResizeHandleKeyDown, handleConnectKeyDown }
}
