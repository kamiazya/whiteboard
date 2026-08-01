/**
 * Pure gesture state machine: pointer/text-edit events in, next state plus
 * an optional `EditorCommand` out. Keeps all drag math out of React so it
 * can be unit-tested without a DOM.
 *
 * Canvas-prop-change-during-gesture policy (this component is controlled,
 * so a sync-driven parent can swap `canvas` mid-gesture):
 *  - if the gesture's target node is missing from the replacement canvas,
 *    or its `type` changed, the gesture ABORTS to `idle` with no command;
 *  - otherwise the gesture CONTINUES and, on completion, commits a delta
 *    computed from the gesture's own START snapshot (not the replacement's
 *    coordinates) — a deliberate last-writer-wins simplification left for
 *    the CRDT slice to refine.
 *
 * Note: `SpatialCanvas` (canvas-model) carries no document-level identity
 * field, so "the same document, different content" and "an unrelated
 * document" are indistinguishable here — both are handled by the same
 * per-node existence/type check above.
 *
 * Open-text-edit-vs-other-gesture policy: `editing-text` carries the
 * in-progress `pendingText` (kept current via `update-text-edit`, one per
 * keystroke). A `pointerdown`/`pointerdown-handle`/`pointerdown-connect`
 * arriving while a text edit is open COMMITS that pending text — emits
 * `set-text` — and then transitions into the requested gesture, matching
 * every text editor's click-away-commits behavior (and this component's
 * own blur-commits convention in `TextNodeEditor`). Escape
 * (`cancel-text-edit`) remains the only explicit discard.
 */
import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import type { EditorCommand } from './commands.js'
import type { ResizeHandleKind } from './geometry.js'
import type { Point } from './viewport.js'

interface MoveSnapshot {
  readonly kind: 'moving'
  readonly nodeId: string
  readonly startType: string
  readonly startPoint: Point
  readonly startX: number
  readonly startY: number
}

interface ResizeSnapshot {
  readonly kind: 'resizing'
  readonly nodeId: string
  readonly startType: string
  readonly handle: ResizeHandleKind
  readonly startPoint: Point
  readonly startBox: { x: number; y: number; width: number; height: number }
}

interface ConnectSnapshot {
  readonly kind: 'connecting'
  readonly fromNodeId: string
}

interface EditTextSnapshot {
  readonly kind: 'editing-text'
  readonly nodeId: string
  readonly pendingText: string
}

interface IdleSnapshot {
  readonly kind: 'idle'
}

export type GestureState =
  | IdleSnapshot
  | MoveSnapshot
  | ResizeSnapshot
  | ConnectSnapshot
  | EditTextSnapshot

export function createIdleState(): GestureState {
  return { kind: 'idle' }
}

export type GestureEvent =
  | { readonly type: 'pointerdown'; readonly nodeId: string; readonly point: Point }
  | {
      readonly type: 'pointerdown-handle'
      readonly nodeId: string
      readonly handle: ResizeHandleKind
      readonly point: Point
      readonly box: { x: number; y: number; width: number; height: number }
    }
  | { readonly type: 'pointerdown-connect'; readonly nodeId: string }
  | { readonly type: 'pointerdown-empty' }
  | { readonly type: 'pointermove'; readonly point: Point }
  | { readonly type: 'pointerup'; readonly point: Point; readonly targetNodeId?: string }
  | { readonly type: 'pointercancel' }
  | { readonly type: 'canvas-replaced'; readonly canvas: SpatialCanvas }
  | { readonly type: 'start-text-edit'; readonly nodeId: string; readonly text: string }
  | { readonly type: 'update-text-edit'; readonly text: string }
  | { readonly type: 'commit-text-edit'; readonly text: string }
  | { readonly type: 'cancel-text-edit' }

export interface GestureResult {
  readonly state: GestureState
  readonly command?: EditorCommand
  /** `string` selects a node, `null` clears selection, `undefined` = no change. */
  readonly selectedId?: string | null
}

const idle: GestureResult = { state: { kind: 'idle' } }

function findNode(canvas: SpatialCanvas, id: string) {
  return canvas.nodes.find((node) => node.id === id)
}

/** Whether the gesture's target(s) are still present, with matching type, in `canvas`. */
function targetsStillValid(state: GestureState, canvas: SpatialCanvas): boolean {
  switch (state.kind) {
    case 'idle':
      return true
    case 'moving':
    case 'resizing':
      return findNode(canvas, state.nodeId)?.type === state.startType
    case 'connecting':
      return findNode(canvas, state.fromNodeId) !== undefined
    case 'editing-text':
      return findNode(canvas, state.nodeId)?.type === 'text'
  }
}

/**
 * When `prevState` is an open text edit, folds its `pendingText` into
 * `result` as a `set-text` command — see the open-text-edit-vs-other-gesture
 * policy documented at the top of this file. `result.command` is always
 * `undefined` for the three pointerdown variants this is applied to, so
 * there is nothing to merge with, only to add.
 */
function withPendingTextCommit(prevState: GestureState, result: GestureResult): GestureResult {
  if (prevState.kind !== 'editing-text') return result
  return {
    ...result,
    command: { kind: 'set-text', id: prevState.nodeId, text: prevState.pendingText },
  }
}

function reduceCanvasReplaced(state: GestureState, replacement: SpatialCanvas): GestureResult {
  if (targetsStillValid(state, replacement)) {
    // Continue the gesture unchanged — the commit still uses the start
    // snapshot captured in `state`, never the replacement's coordinates.
    return { state }
  }
  return idle
}

function reducePointerDown(
  event: Extract<GestureEvent, { type: 'pointerdown' }>,
  canvas: SpatialCanvas,
): GestureResult {
  const node = findNode(canvas, event.nodeId)
  if (node === undefined) return idle
  return {
    state: {
      kind: 'moving',
      nodeId: event.nodeId,
      startType: node.type,
      startPoint: event.point,
      startX: node.x,
      startY: node.y,
    },
    selectedId: event.nodeId,
  }
}

function reducePointerDownHandle(
  event: Extract<GestureEvent, { type: 'pointerdown-handle' }>,
  canvas: SpatialCanvas,
): GestureResult {
  const node = findNode(canvas, event.nodeId)
  if (node === undefined) return idle
  return {
    state: {
      kind: 'resizing',
      nodeId: event.nodeId,
      startType: node.type,
      handle: event.handle,
      startPoint: event.point,
      startBox: event.box,
    },
  }
}

function reducePointerUpMoving(
  state: MoveSnapshot,
  event: Extract<GestureEvent, { type: 'pointerup' }>,
): GestureResult {
  const dx = event.point.x - state.startPoint.x
  const dy = event.point.y - state.startPoint.y
  if (dx === 0 && dy === 0) return idle
  return {
    state: { kind: 'idle' },
    command: { kind: 'move-node', id: state.nodeId, x: state.startX + dx, y: state.startY + dy },
  }
}

const HANDLE_SIGN: Record<ResizeHandleKind, { x: -1 | 0 | 1; y: -1 | 0 | 1 }> = {
  nw: { x: -1, y: -1 },
  n: { x: 0, y: -1 },
  ne: { x: 1, y: -1 },
  e: { x: 1, y: 0 },
  se: { x: 1, y: 1 },
  s: { x: 0, y: 1 },
  sw: { x: -1, y: 1 },
  w: { x: -1, y: 0 },
}

function reducePointerUpResizing(
  state: ResizeSnapshot,
  event: Extract<GestureEvent, { type: 'pointerup' }>,
): GestureResult {
  const rawDx = event.point.x - state.startPoint.x
  const rawDy = event.point.y - state.startPoint.y
  const sign = HANDLE_SIGN[state.handle]
  const { startBox } = state
  // Moving an edge/corner changes width/height by the signed delta and, for
  // the min-side handles (x=-1/y=-1), also shifts the origin so the OPPOSITE
  // corner stays fixed. Clamp the delta to the box's own size BEFORE
  // deriving x/y from it: `commands.ts`'s `toSize` floors the emitted
  // width/height at 0, and if x/y were derived from the raw, unclamped
  // delta instead of this same floor, an overshoot drag would keep sliding
  // the origin past the size clamp — moving the opposite corner instead of
  // leaving it fixed.
  const dx = sign.x === -1 ? Math.min(rawDx, startBox.width) : Math.max(rawDx, -startBox.width)
  const dy = sign.y === -1 ? Math.min(rawDy, startBox.height) : Math.max(rawDy, -startBox.height)
  const nextWidth = startBox.width + sign.x * dx
  const nextHeight = startBox.height + sign.y * dy
  const nextX = sign.x === -1 ? startBox.x + dx : startBox.x
  const nextY = sign.y === -1 ? startBox.y + dy : startBox.y
  const isUnchanged =
    nextX === startBox.x &&
    nextY === startBox.y &&
    nextWidth === startBox.width &&
    nextHeight === startBox.height
  if (isUnchanged) return idle
  return {
    state: { kind: 'idle' },
    command: {
      kind: 'resize-node',
      id: state.nodeId,
      x: nextX,
      y: nextY,
      width: nextWidth,
      height: nextHeight,
    },
  }
}

function reducePointerUpConnecting(
  state: ConnectSnapshot,
  event: Extract<GestureEvent, { type: 'pointerup' }>,
  createEdgeId: () => string,
): GestureResult {
  if (event.targetNodeId === undefined || event.targetNodeId === state.fromNodeId) return idle
  return {
    state: { kind: 'idle' },
    command: {
      kind: 'connect-nodes',
      edgeId: createEdgeId(),
      fromNode: state.fromNodeId,
      toNode: event.targetNodeId,
    },
  }
}

export interface ReduceGestureOptions {
  /** Injection seam for deterministic tests; defaults to crypto.randomUUID. */
  readonly createEdgeId?: () => string
}

const defaultCreateEdgeId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : String(Math.random())

export function reduceGesture(
  state: GestureState,
  canvas: SpatialCanvas,
  event: GestureEvent,
  options: ReduceGestureOptions = {},
): GestureResult {
  const createEdgeId = options.createEdgeId ?? defaultCreateEdgeId

  switch (event.type) {
    case 'canvas-replaced':
      return reduceCanvasReplaced(state, event.canvas)
    case 'pointercancel':
    case 'cancel-text-edit':
      return idle
    case 'pointerdown-empty':
      return { state: { kind: 'idle' }, selectedId: null }
    case 'pointerdown':
      return withPendingTextCommit(state, reducePointerDown(event, canvas))
    case 'pointerdown-handle':
      return withPendingTextCommit(state, reducePointerDownHandle(event, canvas))
    case 'pointerdown-connect':
      return withPendingTextCommit(state, {
        state: { kind: 'connecting', fromNodeId: event.nodeId },
      })
    case 'start-text-edit':
      return { state: { kind: 'editing-text', nodeId: event.nodeId, pendingText: event.text } }
    case 'update-text-edit':
      if (state.kind !== 'editing-text') return { state }
      return { state: { ...state, pendingText: event.text } }
    case 'commit-text-edit':
      if (state.kind !== 'editing-text') return idle
      return {
        state: { kind: 'idle' },
        command: { kind: 'set-text', id: state.nodeId, text: event.text },
      }
    case 'pointermove':
      // Pure state passthrough: the reducer recomputes the commit from
      // startPoint/current point at pointerup, so no intermediate point needs
      // to be stored on the state for move/resize. Connecting has no other
      // state to update either (the in-flight line is component-rendered from
      // the raw pointer position, not reducer state).
      return { state }
    case 'pointerup':
      switch (state.kind) {
        case 'moving':
          return reducePointerUpMoving(state, event)
        case 'resizing':
          return reducePointerUpResizing(state, event)
        case 'connecting':
          return reducePointerUpConnecting(state, event, createEdgeId)
        default:
          return idle
      }
  }
}
