/**
 * Pure gesture state machine: pointer/text-edit events in, next state plus
 * zero or more `EditorCommand`s out. Keeps all drag math out of React so it
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
 * Note: `SpatialCanvas` (model) carries no document-level identity
 * field, so "the same document, different content" and "an unrelated
 * document" are indistinguishable here — both are handled by the same
 * per-node existence/type check above.
 *
 * Open-text-edit-vs-other-gesture policy: `editing-text` carries the
 * in-progress `pendingText` (kept current via `update-text-edit`, one per
 * keystroke). A `pointerdown`/`pointerdown-handle`/`pointerdown-connect`/
 * `pointerdown-empty`/`dblclick-empty`, or a `start-text-edit` naming a
 * DIFFERENT node, arriving while a text edit is open COMMITS that pending
 * text — emits `set-text` — and then proceeds with the
 * requested gesture, matching every text editor's click-away-commits
 * behavior (and this component's own blur-commits convention in
 * `TextNodeEditor`). Escape (`cancel-text-edit`) remains the only explicit
 * discard, and it discards the whole node when the node existed only to
 * hold that edit.
 */
import type { SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import type { EditorCommand } from './commands.js'
import { type Box, type ResizeHandleKind, resizeBoxByDelta, scaleBoxWithin } from './geometry.js'
import type { Point } from './viewport.js'

interface MoveSnapshot {
  readonly kind: 'moving'
  readonly nodeId: string
  readonly startType: string
  readonly startPoint: Point
  readonly startX: number
  readonly startY: number
}

interface ResizeMember {
  readonly id: string
  readonly box: Box
}

interface ResizeSnapshot {
  readonly kind: 'resizing'
  /** The primary node — what the validity check follows across a canvas swap. */
  readonly nodeId: string
  readonly startType: string
  readonly handle: ResizeHandleKind
  readonly startPoint: Point
  /** The box the handles surround: one node's, or the selection's union. */
  readonly startBox: Box
  /**
   * Every node the handles act on, with the box it started at. Absent for a
   * single-node resize, which keeps the original one-command path exactly —
   * a multi-selection is the addition, not a rewrite of the common case.
   */
  readonly members?: readonly ResizeMember[]
}

interface ConnectSnapshot {
  readonly kind: 'connecting'
  readonly fromNodeId: string
}

interface EditTextSnapshot {
  readonly kind: 'editing-text'
  readonly nodeId: string
  readonly pendingText: string
  /**
   * The node came into existence to hold this edit (double-click on empty
   * canvas, the + menu). Cancelling such an edit has nothing to revert TO,
   * so the node goes with it — an empty box the user has to clean up is
   * debris, not a discarded edit.
   */
  readonly createdForEdit?: boolean
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
      readonly box: Box
      /** Present when the handles surround a multi-selection; see ResizeSnapshot. */
      readonly members?: readonly ResizeMember[]
    }
  | { readonly type: 'pointerdown-connect'; readonly nodeId: string }
  | { readonly type: 'pointerdown-empty' }
  | { readonly type: 'dblclick-empty'; readonly point: Point }
  | { readonly type: 'delete-selection'; readonly nodeId: string }
  | { readonly type: 'pointermove'; readonly point: Point }
  | { readonly type: 'pointerup'; readonly point: Point; readonly targetNodeId?: string }
  | { readonly type: 'pointercancel' }
  | {
      readonly type: 'canvas-replaced'
      readonly canvas: SpatialCanvas
      /**
       * 'external' (undo, redo, remote import, hydrate) always cancels an
       * in-flight gesture — the editor's derived state must never describe a
       * canvas that no longer exists, even when the gesture's target node
       * happens to still be present (the undo shape: reverted, not removed).
       * 'local' (the controlled re-render from the editor's own onChange)
       * defaults to the pre-existing continue-if-valid behavior, which in
       * practice is a no-op since a local commit only ever lands once a
       * gesture has already resolved to idle.
       */
      readonly origin?: 'local' | 'external'
    }
  | { readonly type: 'start-text-edit'; readonly nodeId: string; readonly text: string }
  | { readonly type: 'update-text-edit'; readonly text: string }
  | { readonly type: 'commit-text-edit'; readonly text: string }
  | { readonly type: 'cancel-text-edit' }

export interface GestureResult {
  readonly state: GestureState
  /** Ordered — applied left-to-right by the caller. Empty when nothing mutates the canvas. */
  readonly commands: readonly EditorCommand[]
  /** `string` selects a node, `null` clears selection, `undefined` = no change. */
  readonly selectedId?: string | null
}

const idle: GestureResult = { state: { kind: 'idle' }, commands: [] }

/** A result that only advances the gesture state: no canvas mutation, no selection change. */
function stateOnly(state: GestureState): GestureResult {
  return { state, commands: [] }
}

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
 * When `prevState` is an open text edit, PREPENDS a `set-text` command
 * carrying its `pendingText` ahead of `result`'s own commands — see the
 * open-text-edit-vs-other-gesture policy documented at the top of this
 * file.
 *
 * It must PREPEND rather than overwrite, because the arms this wraps can
 * already carry a command of their own — `dblclick-empty` carries
 * `create-node`. Overwriting drops that one, leaving the returned gesture
 * state referencing a node the canvas never received. Prepending also fixes
 * the order: the text belongs to the node being left, so it has to commit
 * before whatever the new gesture does.
 */
function withPendingTextCommit(prevState: GestureState, result: GestureResult): GestureResult {
  if (prevState.kind !== 'editing-text') return result
  const commit: EditorCommand = {
    kind: 'set-text',
    id: prevState.nodeId,
    text: prevState.pendingText,
  }
  return { ...result, commands: [commit, ...result.commands] }
}

function reduceCanvasReplaced(
  state: GestureState,
  replacement: SpatialCanvas,
  origin: 'local' | 'external',
): GestureResult {
  if (origin === 'external') return idle
  if (targetsStillValid(state, replacement)) {
    // Continue the gesture unchanged — the commit still uses the start
    // snapshot captured in `state`, never the replacement's coordinates.
    return stateOnly(state)
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
    commands: [],
    selectedId: event.nodeId,
  }
}

function reducePointerDownHandle(
  event: Extract<GestureEvent, { type: 'pointerdown-handle' }>,
  canvas: SpatialCanvas,
): GestureResult {
  const node = findNode(canvas, event.nodeId)
  if (node === undefined) return idle
  return stateOnly({
    kind: 'resizing',
    nodeId: event.nodeId,
    startType: node.type,
    handle: event.handle,
    startPoint: event.point,
    startBox: event.box,
    ...(event.members === undefined ? {} : { members: event.members }),
  })
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
    commands: [{ kind: 'move-node', id: state.nodeId, x: state.startX + dx, y: state.startY + dy }],
  }
}

function reducePointerUpResizing(
  state: ResizeSnapshot,
  event: Extract<GestureEvent, { type: 'pointerup' }>,
): GestureResult {
  const rawDx = event.point.x - state.startPoint.x
  const rawDy = event.point.y - state.startPoint.y
  const { startBox } = state
  const nextBox = resizeBoxByDelta(startBox, state.handle, rawDx, rawDy)
  const isUnchanged =
    nextBox.x === startBox.x &&
    nextBox.y === startBox.y &&
    nextBox.width === startBox.width &&
    nextBox.height === startBox.height
  if (isUnchanged) return idle
  // A single node takes the dragged box verbatim, including the collapse to
  // zero that overshooting a min-side handle produces. Its handles come back
  // with it, so a collapsed node is still reachable.
  if (state.members === undefined) {
    return {
      state: { kind: 'idle' },
      commands: [
        {
          kind: 'resize-node',
          id: state.nodeId,
          x: nextBox.x,
          y: nextBox.y,
          width: nextBox.width,
          height: nextBox.height,
        },
      ],
    }
  }
  // Handles around a selection surround the union, so each member is
  // re-placed inside the box they moved — the group behaves as one object
  // rather than resizing the primary and leaving the rest behind. Members
  // keep a one-pixel floor that a lone node does not: a member collapsed
  // inside a group has no handles of its own to grab it back by.
  return {
    state: { kind: 'idle' },
    commands: state.members.map((member) => {
      const box = scaleBoxWithin(startBox, nextBox, member.box)
      return {
        kind: 'resize-node',
        id: member.id,
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
      }
    }),
  }
}

function reducePointerUpConnecting(
  state: ConnectSnapshot,
  event: Extract<GestureEvent, { type: 'pointerup' }>,
  createId: () => string,
): GestureResult {
  // Releasing over empty space cancels. Releasing over the SOURCE node
  // keeps the connect armed: that is the first click of the object-first
  // click-A-click-B flow (the press and its own release both land on A),
  // and in the drag flow it just means "still choosing a target".
  if (event.targetNodeId === undefined) return idle
  if (event.targetNodeId === state.fromNodeId) return stateOnly(state)
  return {
    state: { kind: 'idle' },
    commands: [
      {
        kind: 'connect-nodes',
        edgeId: createId(),
        fromNode: state.fromNodeId,
        toNode: event.targetNodeId,
      },
    ],
  }
}

/** Default geometry (canvas-space px) for a node created via dblclick-empty/Add-note. */
export const NEW_NODE_WIDTH = 200
export const NEW_NODE_HEIGHT = 100

/**
 * Builds the freshly-created text node, centered on `point`, plus the
 * `create-node` command/state transition that opens it for typing
 * immediately — a node you must double-click again to type into is a worse
 * affordance than Excalidraw's.
 */
function newTextNodeAt(point: Point, id: string): SpatialNode {
  return {
    id,
    type: 'text',
    x: Math.round(point.x - NEW_NODE_WIDTH / 2),
    y: Math.round(point.y - NEW_NODE_HEIGHT / 2),
    width: NEW_NODE_WIDTH,
    height: NEW_NODE_HEIGHT,
    text: '',
  }
}

function reduceCreateTextNodeAt(point: Point, createId: () => string): GestureResult {
  const id = createId()
  const node = newTextNodeAt(point, id)
  return {
    state: { kind: 'editing-text', nodeId: id, pendingText: '', createdForEdit: true },
    commands: [{ kind: 'create-node', node }],
    selectedId: id,
  }
}

export interface ReduceGestureOptions {
  /** Injection seam for deterministic tests; defaults to crypto.randomUUID. Used for both node and edge ids. */
  readonly createId?: () => string
}

const defaultCreateId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : String(Math.random())

export function reduceGesture(
  state: GestureState,
  canvas: SpatialCanvas,
  event: GestureEvent,
  options: ReduceGestureOptions = {},
): GestureResult {
  const createId = options.createId ?? defaultCreateId

  switch (event.type) {
    case 'canvas-replaced':
      return reduceCanvasReplaced(state, event.canvas, event.origin ?? 'local')
    case 'pointercancel':
      // The platform tore the gesture down mid-flight; a node created for
      // the edit it interrupted is debris, not a decision. Distinct from the
      // explicit cancel below on purpose — the lost-capture handling relies
      // on a real pointercancel staying a discard.
      if (state.kind === 'editing-text' && state.createdForEdit === true) {
        return {
          state: { kind: 'idle' },
          commands: [{ kind: 'delete-node', id: state.nodeId }],
          selectedId: null,
        }
      }
      return idle
    case 'cancel-text-edit':
      if (state.kind === 'editing-text' && state.createdForEdit === true) {
        // Escape discards what was TYPED, and takes the node with it only
        // when there is typed text to discard. With nothing typed, Escape
        // just closes the editor: an empty note is a layout tool (it is the
        // rectangle this product deliberately does not have a second kind
        // for), and eating it punished exactly the person sketching boxes.
        if (state.pendingText === '') {
          return { state: { kind: 'idle' }, commands: [], selectedId: state.nodeId }
        }
        return {
          state: { kind: 'idle' },
          commands: [{ kind: 'delete-node', id: state.nodeId }],
          selectedId: null,
        }
      }
      return idle
    case 'pointerdown-empty':
      return withPendingTextCommit(state, {
        state: { kind: 'idle' },
        commands: [],
        selectedId: null,
      })
    case 'dblclick-empty':
      return withPendingTextCommit(state, reduceCreateTextNodeAt(event.point, createId))
    case 'delete-selection':
      if (state.kind === 'editing-text') return stateOnly(state)
      return {
        state: { kind: 'idle' },
        commands: [{ kind: 'delete-node', id: event.nodeId }],
        selectedId: null,
      }
    case 'pointerdown':
      return withPendingTextCommit(state, reducePointerDown(event, canvas))
    case 'pointerdown-handle':
      return withPendingTextCommit(state, reducePointerDownHandle(event, canvas))
    case 'pointerdown-connect':
      return withPendingTextCommit(
        state,
        stateOnly({ kind: 'connecting', fromNodeId: event.nodeId }),
      )
    case 'start-text-edit':
      // Opening an editor SOMEWHERE ELSE leaves the current one, so it
      // commits like every other way out (see the policy at the top of this
      // file). This arm reaches the reducer with no pointerdown in front of
      // it — the context menu's "Edit text" verb dispatches it directly, and
      // the right-click that opened the menu returned early from
      // `handlePointerDown` — so nothing upstream has already committed.
      // Re-opening the SAME node is excluded: `event.text` was read from the
      // canvas before any commit could land, so committing and then
      // re-seeding from it would write the pending text and immediately
      // discard it.
      if (state.kind === 'editing-text' && state.nodeId === event.nodeId) {
        return stateOnly({ ...state, pendingText: event.text })
      }
      return withPendingTextCommit(
        state,
        stateOnly({ kind: 'editing-text', nodeId: event.nodeId, pendingText: event.text }),
      )
    case 'update-text-edit':
      if (state.kind !== 'editing-text') return stateOnly(state)
      return stateOnly({ ...state, pendingText: event.text })
    case 'commit-text-edit':
      if (state.kind !== 'editing-text') return idle
      return {
        state: { kind: 'idle' },
        commands: [{ kind: 'set-text', id: state.nodeId, text: event.text }],
      }
    case 'pointermove':
      // Pure state passthrough: this reducer never stores an intermediate
      // point on the state — the eventual commit is always recomputed from
      // startPoint/current point at pointerup, for move, resize, AND
      // connect. A live preview (drag outline, in-flight connect line) is
      // therefore always a projection SpatialEditor.tsx derives itself from
      // its own component-local pointer state (see `computeDragPreview` in
      // drag-preview.ts) — this reducer has no opinion on it one way or the
      // other, and no visual state ever needs to round-trip through here.
      return stateOnly(state)
    case 'pointerup':
      switch (state.kind) {
        case 'moving':
          return reducePointerUpMoving(state, event)
        case 'resizing':
          return reducePointerUpResizing(state, event)
        case 'connecting':
          return reducePointerUpConnecting(state, event, createId)
        case 'editing-text':
          // A double-press opens the editor on the SECOND pointerdown; that
          // press's own pointerup arrives afterwards and must not tear the
          // editor down again.
          return stateOnly(state)
        default:
          return idle
      }
  }
}
