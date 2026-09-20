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
import { nodeKind, nodeText, RESOURCE_KINDS } from '@kamiazya/whiteboard-model'
import type { EditorCommand } from '../../lib/spatial/commands.js'
import { moveInkCommand } from '../../lib/spatial/commands.js'
import { freehandLine } from '../../lib/spatial/freehand.js'
import {
  type Box,
  boxContains,
  type ResizeHandleKind,
  resizeBoxByDelta,
  scaleBoxWithin,
} from '../../lib/spatial/geometry.js'
import type { Point } from '../../lib/spatial/viewport.js'
import {
  type BendSnapshot,
  bendCommands,
  bendTargetExists,
  movedWaypoints,
  storedWaypoints,
} from './gesture-bends.js'

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

/**
 * A freehand stroke in progress: every sample the pointer has emitted since
 * it went down, in canvas coordinates.
 *
 * The one gesture that keeps intermediate points, and it has to — see the
 * `pointermove` arm. `zoom` rides along because what counts as jitter, and
 * what counts as a tap, are screen distances, and the release has no viewport
 * to ask.
 */
interface DrawSnapshot {
  readonly kind: 'drawing'
  /**
   * The mark this stroke joins, decided at the PRESS and carried to the
   * release. Decided there because that is where the timing and the starting
   * point are, and by the caller because the decision reads a clock — see
   * `stroke-group.ts`.
   */
  readonly group?: string
  readonly points: readonly Point[]
  readonly zoom: number
}

/**
 * Strokes travelling under the pointer.
 *
 * Its own state rather than an arm of `MoveSnapshot`, and the difference is
 * the model's: a node is moved to an absolute position computed from ONE
 * origin, and ink has no origin — `move-line` takes a delta, so what this
 * has to remember is where the press landed and nothing else. Sharing the
 * node state would have meant inventing a reference point for a set of
 * strokes, which is exactly what the command's shape refuses to do.
 */
interface MoveInkSnapshot {
  readonly kind: 'moving-ink'
  /** Every stroke travelling — the selection, not the one pressed. */
  readonly ids: readonly string[]
  readonly startPoint: Point
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
  | BendSnapshot
  | DrawSnapshot
  | MoveInkSnapshot

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
  | {
      readonly type: 'pointerdown-bend'
      readonly edgeId: string
      /** Which point of `waypoints` the pointer is dragging. */
      readonly index: number
      /** The list the edge ends with, before the drag is applied. */
      readonly waypoints: readonly Point[]
      readonly point: Point
    }
  /** Take one bend back out. No drag, so it is not a pointer gesture. */
  | { readonly type: 'remove-bend'; readonly edgeId: string; readonly index: number }
  /**
   * Nudge one bend — the keyboard's version of the drag, the same way the
   * resize handles answer arrow keys. It reads the edge's STORED list
   * rather than being handed one, because a keyboard never adds a point: it
   * can only move a bend that is already there to be focused.
   */
  | {
      readonly type: 'move-bend'
      readonly edgeId: string
      readonly index: number
      readonly dx: number
      readonly dy: number
    }
  /**
   * The pointer went down on INK. Carries every stroke that should travel,
   * decided by the caller: the press rule (a member keeps the set, anything
   * else replaces it) is the editor's, and the mark a stroke belongs to is
   * `ink-hit.ts`'s.
   */
  | { readonly type: 'pointerdown-ink'; readonly ids: readonly string[]; readonly point: Point }
  | { readonly type: 'pointerdown-empty' }
  /**
   * The pen went down on the board. Carries the viewport's zoom for the
   * screen-sized thresholds in `freehandLine`, since nothing downstream of
   * here knows the magnification the stroke was drawn at.
   */
  | {
      readonly type: 'pointerdown-draw'
      readonly point: Point
      readonly zoom: number
      readonly group?: string
    }
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
/** The bends an edge stores — its own field since ADR-0037 slice 4. */

/**
 * What a gesture records about the node it started on, so it can abandon
 * itself if that node becomes something else mid-drag. `''` for a node
 * showing a resource this build cannot read: one class, and every such node
 * compares equal to every other, which is the same thing the old
 * `node.type` did for the four arms it knew.
 */
function startKindOf(node: SpatialNode): string {
  return nodeKind(node) ?? ''
}

function targetsStillValid(state: GestureState, canvas: SpatialCanvas): boolean {
  switch (state.kind) {
    case 'idle':
      return true
    case 'moving':
    case 'resizing': {
      const target = findNode(canvas, state.nodeId)
      return target !== undefined && startKindOf(target) === state.startType
    }
    case 'connecting':
      return findNode(canvas, state.fromNodeId) !== undefined
    case 'editing-text': {
      const target = findNode(canvas, state.nodeId)
      return target !== undefined && nodeText(target) !== undefined
    }
    case 'bending':
      // Both collections: a stroke's bends are dragged from the same
      // affordance, so a canvas replaced mid-drag would otherwise abandon
      // the gesture on the ground that the element had vanished.
      return bendTargetExists(canvas, state.edgeId)
    case 'moving-ink':
      // As long as ONE of them survives there is still a move to make; the
      // release drops whatever went. Requiring all of them would abandon a
      // whole scribble because a collaborator erased one stroke of it.
      return state.ids.some((id) => (canvas.lines ?? []).some((line) => line.id === id))
    case 'drawing':
      // A stroke is drawn ON the board, not on anything in it, so no
      // element arriving or leaving can invalidate it.
      return true
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
      startType: startKindOf(node),
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
    startType: startKindOf(node),
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

function reducePointerUpBending(
  state: BendSnapshot,
  event: Extract<GestureEvent, { type: 'pointerup' }>,
  canvas: SpatialCanvas,
): GestureResult {
  const dx = event.point.x - state.startPoint.x
  const dy = event.point.y - state.startPoint.y
  // A press that never moved stores nothing: on a ghost handle that would
  // leave a bend where the line already ran, which is a point a person did
  // not ask for and then has to find and remove.
  if (dx === 0 && dy === 0) return idle
  const moved = movedWaypoints(state.waypoints, state.index, dx, dy)
  return { state: { kind: 'idle' }, commands: bendCommands(canvas, state.edgeId, moved) }
}

function reducePointerUpMovingInk(
  state: MoveInkSnapshot,
  event: Extract<GestureEvent, { type: 'pointerup' }>,
  canvas: SpatialCanvas,
): GestureResult {
  const dx = event.point.x - state.startPoint.x
  const dy = event.point.y - state.startPoint.y
  // A press that never travelled writes nothing — the same rule the bend
  // drag keeps, and what makes a plain press on ink stay a plain selection.
  if (dx === 0 && dy === 0) return idle
  const commands = state.ids.flatMap((id) => {
    const command = moveInkCommand(canvas, id, dx, dy)
    return command === undefined ? [] : [command]
  })
  if (commands.length === 0) return idle
  // ONE batch: moving a scribble is one action and must undo as one step.
  return { state: { kind: 'idle' }, commands: [{ kind: 'batch', commands }] }
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
  canvas: SpatialCanvas,
): GestureResult {
  // Releasing over the SOURCE node keeps the connect armed: that is the
  // first click of the object-first click-A-click-B flow (the press and its
  // own release both land on A), and in the drag flow it just means "still
  // choosing a target".
  //
  // Releasing over EMPTY canvas draws a line. It used to cancel, and could
  // not have done anything else: an edge is a RELATION and cannot end in
  // empty space, so there was nothing to make. ADR-0038 decision 2 split ink
  // from relation, and a line's end is exactly the `{kind:'point'}` this
  // release has been carrying all along.
  //
  // The click flow is unaffected, which is worth stating because it looks
  // like it should be: cancelling an armed connect means pressing empty
  // canvas, and `pointerdown-empty` resets to idle BEFORE its pointerup
  // arrives, so this arm never sees it. The only gesture that changed is a
  // real drag off the connect handle.
  if (event.targetNodeId === state.fromNodeId) return stateOnly(state)
  if (event.targetNodeId === undefined) {
    const source = findNode(canvas, state.fromNodeId)
    // A release still inside the source box is not a drag anywhere: the
    // handle is drawn on the node and can overhang it, and a line from a box
    // to itself is zero-length ink that cannot then be clicked to remove.
    if (source !== undefined && boxContains(source, event.point)) return idle
    return {
      state: { kind: 'idle' },
      commands: [
        {
          kind: 'create-line',
          line: {
            id: createId(),
            from: { kind: 'node', node: state.fromNodeId },
            to: { kind: 'point', point: { x: event.point.x, y: event.point.y } },
          },
        },
      ],
    }
  }
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
    x: Math.round(point.x - NEW_NODE_WIDTH / 2),
    y: Math.round(point.y - NEW_NODE_HEIGHT / 2),
    width: NEW_NODE_WIDTH,
    height: NEW_NODE_HEIGHT,
    resource: { mimeType: RESOURCE_KINDS.text.mimeType, content: '' },
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

export const defaultCreateId = () =>
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
    case 'pointerdown-ink': {
      // Only strokes travel. An id naming a RELATION is dropped here rather
      // than at the release: an edge's path is routed from the boxes it
      // joins, so there is nothing of its own to move, and a gesture armed
      // over nothing would swallow the press that should have started a
      // band.
      const ids = event.ids.filter((id) => (canvas.lines ?? []).some((line) => line.id === id))
      if (ids.length === 0) return idle
      return withPendingTextCommit(state, {
        state: { kind: 'moving-ink', ids, startPoint: event.point },
        commands: [],
        // The NODE selection goes, the same way `pointerdown-empty` drops it
        // — which is the event this arm replaced for a press on ink. Without
        // it a node selected a moment earlier stayed selected behind the
        // stroke, and the next Delete took both. Found by the full browser
        // run: the drag's own tests never selected a node first.
        selectedId: null,
      })
    }
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
    case 'pointerdown-draw':
      return withPendingTextCommit(
        state,
        stateOnly({
          kind: 'drawing',
          points: [event.point],
          zoom: event.zoom,
          ...(event.group === undefined ? {} : { group: event.group }),
        }),
      )
    case 'pointerdown':
      return withPendingTextCommit(state, reducePointerDown(event, canvas))
    case 'pointerdown-handle':
      return withPendingTextCommit(state, reducePointerDownHandle(event, canvas))
    case 'pointerdown-connect':
      return withPendingTextCommit(
        state,
        stateOnly({ kind: 'connecting', fromNodeId: event.nodeId }),
      )
    case 'pointerdown-bend': {
      if (!bendTargetExists(canvas, event.edgeId)) return idle
      if (event.waypoints[event.index] === undefined) return idle
      return withPendingTextCommit(
        state,
        stateOnly({
          kind: 'bending',
          edgeId: event.edgeId,
          index: event.index,
          startPoint: event.point,
          waypoints: event.waypoints,
        }),
      )
    }
    case 'move-bend': {
      const stored = storedWaypoints(canvas, event.edgeId)
      const point = stored[event.index]
      if (point === undefined || (event.dx === 0 && event.dy === 0)) return idle
      return {
        state: { kind: 'idle' },
        commands: bendCommands(
          canvas,
          event.edgeId,
          movedWaypoints(stored, event.index, event.dx, event.dy),
        ),
      }
    }
    case 'remove-bend': {
      const stored = storedWaypoints(canvas, event.edgeId)
      if (stored[event.index] === undefined) return idle
      return {
        state: { kind: 'idle' },
        commands: bendCommands(
          canvas,
          event.edgeId,
          stored.filter((_point, at) => at !== event.index),
        ),
      }
    }
    case 'start-text-edit':
      // Opening an editor SOMEWHERE ELSE leaves the current one, so it
      // commits like every other way out (see the policy at the top of this
      // file). This arm reaches the reducer with no pointerdown in front of
      // it — the context menu's "Edit text" verb dispatches it directly, and
      // the right-click that opened the menu returned early from
      // `handlePointerDown` — so nothing upstream has already committed.
      // Re-opening the SAME node is a NO-OP, not a re-seed. There is
      // nothing to commit — the edit never left — and `event.text` is the
      // node's last COMMITTED text, so seeding from it would replace what
      // the user has typed since. That is the same silent loss this arm
      // exists to prevent, one carve-out further in.
      if (state.kind === 'editing-text' && state.nodeId === event.nodeId) {
        return stateOnly(state)
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
      //
      // A STROKE is the exception, and it is not a relaxation of that rule
      // so much as the case the rule cannot cover: the samples ARE the
      // gesture, and there is nothing to recompute them from at the release.
      // So the drawing arm accumulates, and the preview reads the same list
      // the commit will — one path, rather than a component-local copy that
      // can disagree with what is written.
      if (state.kind === 'drawing') {
        return stateOnly({ ...state, points: [...state.points, event.point] })
      }
      return stateOnly(state)
    case 'pointerup':
      switch (state.kind) {
        case 'moving':
          return reducePointerUpMoving(state, event)
        case 'resizing':
          return reducePointerUpResizing(state, event)
        case 'connecting':
          return reducePointerUpConnecting(state, event, createId, canvas)
        case 'bending':
          return reducePointerUpBending(state, event, canvas)
        case 'moving-ink':
          return reducePointerUpMovingInk(state, event, canvas)
        case 'drawing': {
          const line = freehandLine(
            createId(),
            [...state.points, event.point],
            state.zoom,
            state.group,
          )
          if (line === undefined) return idle
          return { state: { kind: 'idle' }, commands: [{ kind: 'create-line', line }] }
        }
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
