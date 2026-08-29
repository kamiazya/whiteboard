/**
 * Command-based model test over the editor's COMPOSITE state — the canvas,
 * the gesture state machine, and the selection together — driven by random
 * sequences of the operations a mouse, a finger, the keyboard and the
 * context menu can actually perform.
 *
 * Why the composite rather than one reducer. `gestures.ts` and
 * `selection.ts` are each pure and each already correct against their own
 * contract; what nothing tested is the state they DERIVE FROM EACH OTHER —
 * a gesture naming a node the canvas no longer holds, a selection naming a
 * node a replacement dropped, a keystroke stranded in `pendingText` when
 * some other surface opens an editor somewhere else. Those live in the
 * seams between the three, which is exactly where per-call-site discipline
 * decays (the same shape that once shipped a three-node selection whose
 * drag moved two nodes) and exactly what a random command sequence reaches
 * that a hand-written example does not.
 *
 * The oracle is the invariant block, not a shadow model: every command
 * re-checks C1/G1/S1/T1/L1 against the real state, so a violation is
 * reported at the step that introduced it with the whole trail attached.
 *
 * What the command set covers, and what it does not. Pointer and touch:
 * press, drag, resize by a handle (single and multi), connect, marquee-
 * clearing empty press, double-click-to-create, pointercancel. Keyboard:
 * every binding in `shortcuts.ts` that can move canvas, gesture or
 * selection state — Delete/Backspace, Escape, arrows (nudge), Cmd+A,
 * Cmd+D, the four z-order brackets, Cmd+Shift+L. Plus the context menu's
 * "Edit text", shift-click membership, and the controlled canvas swap.
 *
 * Deliberately outside it: the viewport bindings (zoom in/out/to-fit/to-
 * selection, space-pan), which cannot touch these three values and have
 * their own property test in `viewport.property.test.ts`; and the
 * clipboard family (Cmd+C/X/V), whose behaviour lives in an in-app
 * fragment slot, a pending-cut hold and the OS clipboard — three more
 * pieces of state that belong in this model but are a separate increment,
 * not a line item. Their absence is why `deletes` counts only what the
 * delete paths produce.
 *
 * `dispatch` mirrors `applyResult` in SpatialEditor.tsx: set the gesture
 * state, fold `selectedId` through `reduceSelection` as `set-primary`, then
 * apply each command left-to-right through `applyCommand`. It deliberately
 * omits that function's React/`onChange`/auto-grow-height half, none of
 * which can change the three state values under test. That mirroring is the
 * one place this file can drift from its subject: a future step added to
 * `applyResult` that DOES touch canvas/gesture/selection has to be added
 * here too.
 */
import {
  type CanvasColor,
  type CanvasEdge,
  type SpatialCanvas,
  type SpatialNode,
  spatialCanvasSchema,
} from '@kamiazya/whiteboard-model'
import { afterAll, describe, expect, it } from 'vitest'
import { extractClipboardFragment } from '../../lib/clipboard-fragment.js'
import { fc, fcTest, withDefaults } from '../../test-utils/fast-check.js'
import { applyCommand, buildFragmentInsertCommand, type EditorCommand } from './commands.js'
import type { Box, ResizeHandleKind } from './geometry.js'
import { createIdleState, type GestureEvent, type GestureState, reduceGesture } from './gestures.js'
import {
  EMPTY_SELECTION,
  reduceSelection,
  type SelectionState,
  selectionMembers,
} from './selection.js'
import type { Point } from './viewport.js'

/**
 * The initial document is GENERATED, not fixed, and the geometry is drawn
 * from a coarse grid on purpose: boxes have to overlap often, because
 * several behaviours are defined in terms of overlap and silently do
 * nothing without it.
 *
 * That is not hypothetical. This model began with four hand-placed,
 * pairwise non-overlapping nodes, and `reorder-forward`/`backward` step
 * the selection over the nearest OVERLAPPING non-member — so they
 * returned the input canvas every time. Measured before the change: 16,
 * 17 and 7 forward/backward attempts across three runs producing 2, 0 and
 * 0 actual reorders. The coverage floor was green throughout, because it
 * counted attempts. Hence both halves of this file's answer — a generator
 * dense enough to reach the arrangement, and counters that only tick when
 * the canvas actually changed.
 *
 * All four node types appear. `group` is included for its geometry and
 * its z-order participation only: the editor's frame-containment rule
 * (dragging a frame carries the nodes inside it) lives in
 * `drag-preview.ts`'s `carriedWithDrag`, which this model does not run —
 * its own tests do.
 */
const NODE_IDS = ['n0', 'n1', 'n2', 'n3', 'n4'] as const

const colorArb = fc.oneof(
  fc.constant(undefined),
  fc.constantFrom<CanvasColor>('1', '2', '3', '4', '5', '6'),
  fc.constant<CanvasColor>('#3a7bd5'),
)

/** Coarse and overlapping: a 40px lattice over a span only 3 cells wide. */
const coordArb = fc.constantFrom(0, 40, 80, 120)
/**
 * Weighted toward boxes WIDER than the lattice they sit on, so a pair of
 * nodes usually overlaps. Overlap is a precondition for `reorder-forward`
 * and `backward` — the effective-reorder counters are what measure whether
 * this weighting is still doing its job.
 *
 * Zero stays in the draw at low weight: it is a legal JSON Canvas size and
 * the editor's collapse-to-zero resize produces one, so documents that
 * already contain the degenerate case are worth starting from. It is rare
 * because a zero-side box overlaps nothing, and a fixture full of them is
 * a fixture that reaches less.
 */
const sizeArb = fc.oneof(
  { arbitrary: fc.constantFrom(120, 160, 200), weight: 7 },
  { arbitrary: fc.constantFrom(40, 80), weight: 2 },
  { arbitrary: fc.constant(0), weight: 1 },
)

function nodeArb(id: string): fc.Arbitrary<SpatialNode> {
  const shared = fc.record({
    x: coordArb,
    y: coordArb,
    width: sizeArb,
    height: sizeArb,
    color: colorArb,
  })
  return fc
    .tuple(
      shared,
      // Weighted, not uniform: `text` is both the commonest node in a real
      // document and the ONLY type the text-edit half of this model can
      // reach, so a uniform draw over four types quarters the pending-text
      // coverage that the T1 invariant depends on.
      fc.oneof(
        { arbitrary: fc.constant('text' as const), weight: 5 },
        { arbitrary: fc.constantFrom('file', 'link', 'group' as const), weight: 3 },
      ),
      fc.string({ maxLength: 8 }),
    )
    .map(([box, kind, text]): SpatialNode => {
      const base = { id, ...box }
      switch (kind) {
        case 'file':
          return { ...base, type: 'file', file: `notes/${id}.md` }
        case 'link':
          return { ...base, type: 'link', url: `https://example.com/${id}` }
        case 'group':
          return { ...base, type: 'group', label: text }
        default:
          return { ...base, type: 'text', text }
      }
    })
}

const sideArb = fc.option(fc.constantFrom('top', 'right', 'bottom', 'left' as const), {
  nil: undefined,
})

/**
 * Edges carry their optional attributes too — sides, ends, colour, label —
 * so the commands that rewrite one attribute are exercised against edges
 * that already have the others, not only against bare ones.
 */
function edgesArb(nodeIds: readonly string[]): fc.Arbitrary<readonly CanvasEdge[]> {
  if (nodeIds.length < 2) return fc.constant([])
  const pair = fc
    .tuple(fc.nat({ max: nodeIds.length - 1 }), fc.nat({ max: nodeIds.length - 1 }))
    .filter(([a, b]) => a !== b)
  return (
    fc
      .array(
        fc.tuple(
          pair,
          sideArb,
          sideArb,
          fc.option(fc.constantFrom('none', 'arrow' as const), { nil: undefined }),
          colorArb,
          fc.option(fc.string({ maxLength: 6 }), { nil: undefined }),
        ),
        { maxLength: 4 },
      )
      .map((raws) =>
        raws.map(([[a, b], fromSide, toSide, toEnd, color, label], i) => ({
          id: `e${i}`,
          fromNode: nodeIds[a],
          toNode: nodeIds[b],
          ...(fromSide === undefined ? {} : { fromSide }),
          ...(toSide === undefined ? {} : { toSide }),
          ...(toEnd === undefined ? {} : { toEnd }),
          ...(color === undefined ? {} : { color }),
          ...(label === undefined ? {} : { label }),
        })),
      )
      // A canvas may not carry two edges with the same id; the index-derived
      // ids are unique by construction, but a duplicated (from, to) pair is
      // legal and deliberately left in — parallel edges are a real document.
      .map((edges) => edges)
  )
}

const initialCanvasArb: fc.Arbitrary<SpatialCanvas> = fc
  .integer({ min: 3, max: NODE_IDS.length })
  .chain((count) => {
    const ids = NODE_IDS.slice(0, count)
    return fc
      .tuple(fc.tuple(...ids.map((id) => nodeArb(id))), edgesArb(ids))
      .map(([nodes, edges]) => ({ nodes: [...nodes], edges: [...edges] }))
  })
  // The generator has to produce documents the MODEL accepts, or every
  // invariant below is asserting about a shape that could never be loaded.
  .map((canvas) => spatialCanvasSchema.parse(canvas))

/** The fixed document the pinned counterexamples replay against. */
function initialCanvas(): SpatialCanvas {
  return {
    nodes: [
      { id: 'n0', type: 'text', x: 0, y: 0, width: 100, height: 60, text: 'zero' },
      { id: 'n1', type: 'text', x: 160, y: 0, width: 100, height: 60, text: 'one' },
      { id: 'n2', type: 'text', x: 0, y: 120, width: 100, height: 60, text: '' },
      {
        id: 'n3',
        type: 'link',
        x: 160,
        y: 120,
        width: 100,
        height: 60,
        url: 'https://example.com/',
      },
    ],
    edges: [{ id: 'e0', fromNode: 'n0', toNode: 'n1' }],
  }
}

interface Stats {
  moveCommits: number
  resizeCommits: number
  connectCommits: number
  deletes: number
  textEditsOpened: number
  /** An open edit carrying typed text that some later event closed. */
  pendingTextHandoffs: number
  externalReplacementsMidGesture: number
  multiSelections: number
  nudges: number
  duplicates: number
  /**
   * Reorders that CHANGED the canvas, not reorders attempted.
   *
   * `reorder-nodes` is total — the extremes and a block already on top of
   * its pile return the input — so an attempt counter says nothing about
   * whether the code under it ran. Forward/backward additionally need an
   * OVERLAPPING non-member, which a tidy fixture never supplies. Split
   * because the two halves fail differently: `front`/`back` work on any
   * document, `forward`/`backward` need the generator to keep producing
   * overlap.
   */
  reordersEffective: number
  stepReordersEffective: number
  locksApplied: number
  selectAlls: number
}

interface Real {
  canvas: SpatialCanvas
  gesture: GestureState
  selection: SelectionState
  /**
   * Lock is HOST state, not part of the canvas — `onToggleNodeLock`
   * reports out and the document never records it. Modelled here anyway
   * because the editor's lock effect reaches back into both of the other
   * two: it cancels a gesture on a node that just got locked, and drops
   * locked ids from the selection.
   */
  lockedNodeIds: Set<string>
  nextId: number
  trail: string[]
  stats: Stats
}

/** The invariants are the oracle; nothing needs a shadow copy of the state. */
type Model = Record<string, never>

function nodeById(canvas: SpatialCanvas, id: string): SpatialNode | undefined {
  return canvas.nodes.find((node) => node.id === id)
}

function liveIds(canvas: SpatialCanvas): ReadonlySet<string> {
  return new Set(canvas.nodes.map((node) => node.id))
}

function checkInvariants(real: Real): void {
  const at = `after ${real.trail.join(' → ')}`
  const { canvas, gesture, selection } = real
  const live = liveIds(canvas)

  // C1: the canvas stays a well-formed document — unique ids, and every
  // edge joins two distinct nodes that exist.
  expect(live.size, `C1 unique node ids ${at}`).toBe(canvas.nodes.length)
  expect(new Set(canvas.edges.map((e) => e.id)).size, `C1 unique edge ids ${at}`).toBe(
    canvas.edges.length,
  )
  for (const edge of canvas.edges) {
    expect(
      live.has(edge.fromNode) && live.has(edge.toNode) && edge.fromNode !== edge.toNode,
      `C1 edge ${edge.id} (${edge.fromNode}→${edge.toNode}) ${at}`,
    ).toBe(true)
  }

  // G1: an in-flight gesture never names a node the canvas has stopped
  // holding, nor one whose type changed under it. This is `targetsStillValid`
  // stated as a standing property rather than a check the reducer only runs
  // on `canvas-replaced`.
  switch (gesture.kind) {
    case 'idle':
      break
    case 'moving':
    case 'resizing':
      expect(nodeById(canvas, gesture.nodeId)?.type, `G1 ${gesture.kind} ${at}`).toBe(
        gesture.startType,
      )
      break
    case 'connecting':
      expect(nodeById(canvas, gesture.fromNodeId), `G1 connecting ${at}`).toBeDefined()
      break
    case 'editing-text':
      expect(nodeById(canvas, gesture.nodeId)?.type, `G1 editing-text ${at}`).toBe('text')
      break
  }

  // S1: nothing selected has been deleted. A dead id in the selection is
  // invisible (every read site filters by laid-out box) right up until a
  // verb reads it back and acts on nothing.
  for (const id of selectionMembers(selection)) {
    expect(live.has(id), `S1 selected ${id} ${at}`).toBe(true)
  }

  // L1: once the lock effect has settled, a locked node is neither
  // selected nor under a move/resize gesture. Both halves are that
  // effect's whole job, and both are the kind of thing that decays into
  // "every verb re-checks isLocked itself".
  for (const id of selectionMembers(selection)) {
    expect(real.lockedNodeIds.has(id), `L1 locked ${id} still selected ${at}`).toBe(false)
  }
  if (gesture.kind === 'moving' || gesture.kind === 'resizing') {
    expect(real.lockedNodeIds.has(gesture.nodeId), `L1 ${gesture.kind} a locked node ${at}`).toBe(
      false,
    )
  }
}

/**
 * The editor's lock effect, run to settlement, then the invariants.
 *
 * The effect is keyed on `[lockEnabled, lockedNodeIds, selectedId,
 * extraIds, gestureState]` — every one of the values this model moves — so
 * it runs after EVERY step, not only after a lock toggle. That ordering is
 * the design and not an accident: pressing a locked node is allowed to
 * start a move and allowed to select it (the hit-test deliberately still
 * sees locked nodes, or Unlock would be unreachable from the context
 * menu), and this effect is what takes both back on the next render. A
 * model that settled only on the toggle reports that transient as an L1
 * violation, which is how this function ended up here rather than inside
 * `ToggleLock`.
 */
function settle(real: Real): void {
  if (
    (real.gesture.kind === 'moving' || real.gesture.kind === 'resizing') &&
    real.lockedNodeIds.has(real.gesture.nodeId)
  ) {
    real.gesture = createIdleState()
  }
  const lockedMembers = new Set(
    selectionMembers(real.selection).filter((id) => real.lockedNodeIds.has(id)),
  )
  if (lockedMembers.size > 0) {
    real.selection = reduceSelection(real.selection, {
      type: 'drop-locked',
      lockedIds: lockedMembers,
    })
  }
  checkInvariants(real)
}

/**
 * Events that are ALLOWED to drop an open edit's typed text: the two
 * explicit discards, plus a canvas replacement (undo/remote — the edit's
 * ground truth went with it) and the commit path, which carries its own
 * authoritative text.
 */
const DISCARDS_PENDING_TEXT: ReadonlySet<GestureEvent['type']> = new Set([
  'cancel-text-edit',
  'pointercancel',
  'canvas-replaced',
  'commit-text-edit',
])

/**
 * T1: typed characters are never dropped on the floor. Leaving an open text
 * edit that holds typed text must either commit it (`set-text`) or take the
 * node with it (`delete-node`) — the policy gestures.ts states for itself at
 * the top of the file, checked here against every way OUT of the state
 * rather than the ones a hand-written example remembered to try.
 */
function checkPendingTextSurvives(
  real: Real,
  before: GestureState,
  event: GestureEvent,
  commands: readonly EditorCommand[],
): void {
  if (before.kind !== 'editing-text' || before.pendingText === '') return
  const stillEditingSameNode =
    real.gesture.kind === 'editing-text' && real.gesture.nodeId === before.nodeId
  if (stillEditingSameNode) return
  real.stats.pendingTextHandoffs += 1
  if (DISCARDS_PENDING_TEXT.has(event.type)) return
  const at = `after ${real.trail.join(' → ')}`
  const committed = commands.some(
    (command) =>
      (command.kind === 'set-text' &&
        command.id === before.nodeId &&
        command.text === before.pendingText) ||
      (command.kind === 'delete-node' && command.id === before.nodeId),
  )
  expect(
    committed,
    `T1 pending text ${JSON.stringify(before.pendingText)} on ${before.nodeId} was neither committed nor deleted ${at}`,
  ).toBe(true)
}

function recordStats(real: Real, before: GestureState, commands: readonly EditorCommand[]): void {
  const { stats } = real
  for (const command of commands) {
    if (command.kind === 'move-node') stats.moveCommits += 1
    if (command.kind === 'resize-node') stats.resizeCommits += 1
    if (command.kind === 'connect-nodes') stats.connectCommits += 1
    if (command.kind === 'delete-node') stats.deletes += 1
  }
  if (before.kind !== 'editing-text' && real.gesture.kind === 'editing-text') {
    stats.textEditsOpened += 1
  }
  if (real.selection.extraIds.size > 0) stats.multiSelections += 1
}

/**
 * One editor step, composed exactly as `applyResult` composes it — see this
 * file's header for what of that function is deliberately not mirrored.
 */
function dispatch(real: Real, event: GestureEvent, label: string): void {
  const before = real.gesture
  const result = reduceGesture(real.gesture, real.canvas, event, {
    createId: () => `made-${real.nextId++}`,
  })
  real.gesture = result.state
  if (result.selectedId !== undefined) {
    real.selection = reduceSelection(real.selection, { type: 'set-primary', id: result.selectedId })
  }
  for (const command of result.commands) real.canvas = applyCommand(real.canvas, command)
  real.trail.push(label)
  recordStats(real, before, result.commands)
  checkPendingTextSurvives(real, before, event, result.commands)
  settle(real)
}

/**
 * The keyboard paths that emit commands WITHOUT going through the gesture
 * reducer — nudge, duplicate, reorder — which in SpatialEditor call
 * `applyResult` with a hand-built result carrying no `selectedId`.
 */
function dispatchCommands(real: Real, commands: readonly EditorCommand[], label: string): void {
  const before = real.gesture
  for (const command of commands) real.canvas = applyCommand(real.canvas, command)
  real.trail.push(label)
  recordStats(real, before, commands)
  settle(real)
}

/**
 * A plain press on a node body, as `handlePointerDown` performs it: the
 * selection `press` transition FIRST, then the gesture's own
 * `set-primary` through `applyResult`.
 *
 * Both halves matter and the model originally had only the second. `press`
 * is what COLLAPSES a multi-selection when the pressed node is not a
 * member — `set-primary` alone preserves the extras — so a model missing
 * it carries selections that are stickier than the editor's, and every
 * command downstream inherits that.
 */
function pressNode(real: Real, nodeId: string, point: Point, label: string): void {
  real.selection = reduceSelection(real.selection, { type: 'press', id: nodeId })
  dispatch(real, { type: 'pointerdown', nodeId, point }, label)
}

/** A command whose whole body is one gesture event. */
abstract class GestureCommand implements fc.Command<Model, Real> {
  check(): boolean {
    return true
  }
  abstract event(real: Real): GestureEvent | undefined
  run(_model: Model, real: Real): void {
    const event = this.event(real)
    if (event === undefined) return
    dispatch(real, event, this.toString())
  }
  abstract toString(): string
}

/**
 * Resolves a generated index against the nodes a pointer can actually
 * reach: live, and not locked.
 *
 * The lock filter is not defensive tidying — `selectableBoxes` is what
 * every pointer path hit-tests against, and it excludes locked nodes, so a
 * command that pressed one would be driving an editor that does not exist.
 * (The context MENU deliberately hit-tests locked nodes so Unlock stays
 * reachable, but a locked node's menu offers only Unlock — no verb this
 * model dispatches.) That leaves the lock effect's gesture-cancel half
 * reachable only the way production needs it: a lock ARRIVING while a
 * gesture is already in flight.
 */
function pick(real: Real, index: number): SpatialNode | undefined {
  const selectable = real.canvas.nodes.filter((node) => !real.lockedNodeIds.has(node.id))
  if (selectable.length === 0) return undefined
  return selectable[index % selectable.length]
}

function pickText(real: Real, index: number): SpatialNode | undefined {
  const texts = real.canvas.nodes.filter(
    (node) => node.type === 'text' && !real.lockedNodeIds.has(node.id),
  )
  if (texts.length === 0) return undefined
  return texts[index % texts.length]
}

class PressNode extends GestureCommand {
  constructor(
    private readonly index: number,
    private readonly point: Point,
  ) {
    super()
  }
  event(): GestureEvent | undefined {
    return undefined
  }
  run(_model: Model, real: Real): void {
    const node = pick(real, this.index)
    if (node === undefined) return
    pressNode(real, node.id, this.point, this.toString())
  }
  toString(): string {
    return `press(#${this.index})`
  }
}

class PressHandle extends GestureCommand {
  constructor(
    private readonly index: number,
    private readonly handle: ResizeHandleKind,
    private readonly point: Point,
    private readonly multi: boolean,
  ) {
    super()
  }
  event(real: Real): GestureEvent | undefined {
    const node = pick(real, this.index)
    if (node === undefined) return undefined
    const box: Box = { x: node.x, y: node.y, width: node.width, height: node.height }
    // Mirrors SelectionOverlay: `members` is present only for a genuine
    // multi-selection, and it is the CURRENT selection the handles surround.
    const members = selectionMembers(real.selection)
      .flatMap((id) => {
        const member = nodeById(real.canvas, id)
        return member === undefined ? [] : [member]
      })
      .map((member) => ({
        id: member.id,
        box: { x: member.x, y: member.y, width: member.width, height: member.height },
      }))
    return {
      type: 'pointerdown-handle',
      nodeId: node.id,
      handle: this.handle,
      point: this.point,
      box,
      ...(this.multi && members.length > 1 ? { members } : {}),
    }
  }
  toString(): string {
    return `pressHandle(#${this.index},${this.handle}${this.multi ? ',multi' : ''})`
  }
}

class PressConnect extends GestureCommand {
  constructor(private readonly index: number) {
    super()
  }
  event(real: Real): GestureEvent | undefined {
    const node = pick(real, this.index)
    if (node === undefined) return undefined
    return { type: 'pointerdown-connect', nodeId: node.id }
  }
  toString(): string {
    return `pressConnect(#${this.index})`
  }
}

class PressEmpty extends GestureCommand {
  event(): GestureEvent {
    return { type: 'pointerdown-empty' }
  }
  toString(): string {
    return 'pressEmpty'
  }
}

class Move extends GestureCommand {
  constructor(private readonly point: Point) {
    super()
  }
  event(): GestureEvent {
    return { type: 'pointermove', point: this.point }
  }
  toString(): string {
    return `move(${this.point.x},${this.point.y})`
  }
}

class Release extends GestureCommand {
  constructor(
    private readonly point: Point,
    private readonly overIndex: number | null,
  ) {
    super()
  }
  event(real: Real): GestureEvent {
    const over = this.overIndex === null ? undefined : pick(real, this.overIndex)
    return {
      type: 'pointerup',
      point: this.point,
      ...(over === undefined ? {} : { targetNodeId: over.id }),
    }
  }
  toString(): string {
    return `release(${this.point.x},${this.point.y}${this.overIndex === null ? '' : `,over#${this.overIndex}`})`
  }
}

class Cancel extends GestureCommand {
  event(): GestureEvent {
    return { type: 'pointercancel' }
  }
  toString(): string {
    return 'pointercancel'
  }
}

class DoubleClickEmpty extends GestureCommand {
  constructor(private readonly point: Point) {
    super()
  }
  event(): GestureEvent {
    return { type: 'dblclick-empty', point: this.point }
  }
  toString(): string {
    return `dblclickEmpty(${this.point.x},${this.point.y})`
  }
}

/**
 * The context menu's "Edit text" verb, and the double-press-to-edit path.
 * Both dispatch `start-text-edit` directly; the right-click that opens the
 * menu returns early from `handlePointerDown` (`e.button !== 0`), so no
 * pointer event precedes it.
 */
class StartTextEdit extends GestureCommand {
  constructor(private readonly index: number) {
    super()
  }
  event(real: Real): GestureEvent | undefined {
    const node = pickText(real, this.index)
    if (node === undefined || node.type !== 'text') return undefined
    return { type: 'start-text-edit', nodeId: node.id, text: node.text }
  }
  toString(): string {
    return `startTextEdit(text#${this.index})`
  }
}

class TypeText extends GestureCommand {
  constructor(private readonly text: string) {
    super()
  }
  event(): GestureEvent {
    return { type: 'update-text-edit', text: this.text }
  }
  toString(): string {
    return `type(${JSON.stringify(this.text)})`
  }
}

class CommitTextEdit extends GestureCommand {
  event(real: Real): GestureEvent {
    const text = real.gesture.kind === 'editing-text' ? real.gesture.pendingText : ''
    return { type: 'commit-text-edit', text }
  }
  toString(): string {
    return 'commitTextEdit'
  }
}

/**
 * Escape. It routes to `cancel-text-edit` only while a gesture is in
 * flight — on an idle editor the key does not reach the reducer at all,
 * and notably does NOT clear the selection (the catalog's description says
 * it does; the handler is the truth).
 */
class CancelTextEdit extends GestureCommand {
  event(real: Real): GestureEvent | undefined {
    return real.gesture.kind === 'idle' ? undefined : { type: 'cancel-text-edit' }
  }
  toString(): string {
    return 'cancelTextEdit'
  }
}

/**
 * The Delete/Backspace key, branching exactly as SpatialEditor's keydown
 * handler does: a multi-selection deletes every member as one result, a
 * lone selection goes through the reducer's `delete-selection`, and an open
 * text edit swallows the key entirely.
 */
class DeleteSelection implements fc.Command<Model, Real> {
  check(): boolean {
    return true
  }
  run(_model: Model, real: Real): void {
    const members = selectionMembers(real.selection).filter((id) => liveIds(real.canvas).has(id))
    if (members.length === 0) return
    if (real.gesture.kind === 'editing-text') return
    if (real.selection.extraIds.size > 0) {
      const before = real.gesture
      const result = {
        state: { kind: 'idle' } as GestureState,
        commands: members.map((id) => ({ kind: 'delete-node', id }) as const),
        selectedId: null,
      }
      real.gesture = result.state
      real.selection = reduceSelection(real.selection, { type: 'set-primary', id: null })
      for (const command of result.commands) real.canvas = applyCommand(real.canvas, command)
      real.trail.push(this.toString())
      recordStats(real, before, result.commands)
      settle(real)
      return
    }
    dispatch(real, { type: 'delete-selection', nodeId: members[0] }, this.toString())
  }
  toString(): string {
    return 'deleteSelection'
  }
}

/** Shift-click membership toggle — `toggleSelectionMember` in SpatialEditor. */
class ToggleMember implements fc.Command<Model, Real> {
  constructor(private readonly index: number) {}
  check(): boolean {
    return true
  }
  run(_model: Model, real: Real): void {
    const node = pick(real, this.index)
    if (node === undefined) return
    real.selection = reduceSelection(real.selection, { type: 'toggle-member', id: node.id })
    real.trail.push(this.toString())
    if (real.selection.extraIds.size > 0) real.stats.multiSelections += 1
    settle(real)
  }
  toString(): string {
    return `toggleMember(#${this.index})`
  }
}

/**
 * A controlled-prop swap: undo/redo/remote import ('external'), or this
 * component's own re-render after `onChange` ('local'). The replacement
 * keeps a random subset of the pool, which is what makes "the node under
 * the gesture, or under the selection, just went away" reachable.
 */
class ReplaceCanvas implements fc.Command<Model, Real> {
  constructor(
    private readonly keep: readonly boolean[],
    private readonly external: boolean,
  ) {}
  check(): boolean {
    return true
  }
  run(_model: Model, real: Real): void {
    const nodes = real.canvas.nodes.filter((_node, index) => this.keep[index] !== false)
    const kept = new Set(nodes.map((node) => node.id))
    const replacement: SpatialCanvas = {
      nodes,
      edges: real.canvas.edges.filter((edge) => kept.has(edge.fromNode) && kept.has(edge.toNode)),
    }
    const missingIds = new Set(
      real.canvas.nodes.map((node) => node.id).filter((id) => !kept.has(id)),
    )
    if (this.external && real.gesture.kind !== 'idle') {
      real.stats.externalReplacementsMidGesture += 1
    }
    // The layout effect feeds the reducer the replacement and takes its
    // answer; the canvas prop itself is the new one either way.
    const before = real.gesture
    const result = reduceGesture(real.gesture, replacement, {
      type: 'canvas-replaced',
      canvas: replacement,
      origin: this.external ? 'external' : 'local',
    })
    real.canvas = replacement
    real.gesture = result.state
    // Mirrors the same layout effect's selection prune: a selection may not
    // outlive the node it names.
    if (missingIds.size > 0) {
      real.selection = reduceSelection(real.selection, { type: 'drop-missing', missingIds })
    }
    real.trail.push(this.toString())
    recordStats(real, before, result.commands)
    checkPendingTextSurvives(
      real,
      before,
      { type: 'canvas-replaced', canvas: replacement },
      result.commands,
    )
    settle(real)
  }
  toString(): string {
    return `replaceCanvas(${this.external ? 'external' : 'local'},keep=${this.keep.map((k) => (k === false ? '0' : '1')).join('')})`
  }
}

/**
 * Whole gestures in one command — press, drag, release — alongside the
 * atomic events above rather than instead of them.
 *
 * Both densities are load-bearing, and the split is measured rather than
 * stylistic. The atomic events are what let a canvas replacement or a
 * context-menu verb land in the MIDDLE of a gesture, which is where the
 * coupling under test lives. But a committed move needs three specific
 * events in order, drawn from a fifteen-way uniform choice: over 300 runs
 * that produced 7 move commits, 5 resizes and 4 connects — thin enough
 * that the coverage floor below would flake, and thin enough that the
 * commit paths were barely being reached at all. Composing the sequence
 * into one draw is what raises those into the hundreds.
 */
class DragNode implements fc.Command<Model, Real> {
  constructor(
    private readonly index: number,
    private readonly from: Point,
    private readonly delta: Point,
  ) {}
  check(): boolean {
    return true
  }
  run(_model: Model, real: Real): void {
    const node = pick(real, this.index)
    if (node === undefined) return
    const to = { x: this.from.x + this.delta.x, y: this.from.y + this.delta.y }
    pressNode(real, node.id, this.from, this.toString())
    dispatch(real, { type: 'pointermove', point: to }, `${this.toString()}:move`)
    dispatch(real, { type: 'pointerup', point: to }, `${this.toString()}:up`)
  }
  toString(): string {
    return `drag(#${this.index},+${this.delta.x},+${this.delta.y})`
  }
}

class ResizeNode implements fc.Command<Model, Real> {
  constructor(
    private readonly index: number,
    private readonly handle: ResizeHandleKind,
    private readonly from: Point,
    private readonly delta: Point,
  ) {}
  check(): boolean {
    return true
  }
  run(_model: Model, real: Real): void {
    const node = pick(real, this.index)
    if (node === undefined) return
    const box: Box = { x: node.x, y: node.y, width: node.width, height: node.height }
    const to = { x: this.from.x + this.delta.x, y: this.from.y + this.delta.y }
    dispatch(
      real,
      { type: 'pointerdown-handle', nodeId: node.id, handle: this.handle, point: this.from, box },
      this.toString(),
    )
    dispatch(real, { type: 'pointerup', point: to }, `${this.toString()}:up`)
  }
  toString(): string {
    return `resize(#${this.index},${this.handle},+${this.delta.x},+${this.delta.y})`
  }
}

class ConnectNodes implements fc.Command<Model, Real> {
  constructor(
    private readonly fromIndex: number,
    private readonly toIndex: number,
  ) {}
  check(): boolean {
    return true
  }
  run(_model: Model, real: Real): void {
    const from = pick(real, this.fromIndex)
    const to = pick(real, this.toIndex)
    if (from === undefined || to === undefined) return
    dispatch(real, { type: 'pointerdown-connect', nodeId: from.id }, this.toString())
    dispatch(
      real,
      { type: 'pointerup', point: { x: to.x, y: to.y }, targetNodeId: to.id },
      `${this.toString()}:up`,
    )
  }
  toString(): string {
    return `connect(#${this.fromIndex}→#${this.toIndex})`
  }
}

/**
 * The keyboard half of the surface. `shortcuts.ts` is the single catalog
 * and declares eighteen bindings; the ones below are those that can move
 * canvas, gesture or selection state. The rest are viewport-only
 * (zoom-in/out/to-fit/to-selection, space-pan — covered by
 * viewport.property.test.ts) or clipboard (copy/cut/paste, whose fragment
 * slot and OS-clipboard half are deliberately out of this model's scope;
 * see the note on the describe block).
 *
 * Each mirrors its handler in SpatialEditor, guards included — the guards
 * ARE the behaviour under test, so a command that skipped them would be
 * asserting against an editor that does not exist.
 */

/** Cmd+A. Locked nodes are excluded, as `selectAllNodes` excludes them. */
class SelectAll implements fc.Command<Model, Real> {
  check(): boolean {
    return true
  }
  run(_model: Model, real: Real): void {
    const ids = real.canvas.nodes.map((node) => node.id).filter((id) => !real.lockedNodeIds.has(id))
    if (ids.length === 0) return
    real.selection = reduceSelection(real.selection, { type: 'set-members', ids })
    real.trail.push(this.toString())
    real.stats.selectAlls += 1
    if (real.selection.extraIds.size > 0) real.stats.multiSelections += 1
    settle(real)
  }
  toString(): string {
    return 'selectAll'
  }
}

/**
 * An arrow key. Nudges the WHOLE selection as ONE batch, from positions
 * read live rather than from a render snapshot, and only while the gesture
 * is idle and the primary still exists.
 */
class Nudge implements fc.Command<Model, Real> {
  constructor(
    private readonly delta: { readonly dx: number; readonly dy: number },
    private readonly large: boolean,
  ) {}
  check(): boolean {
    return true
  }
  run(_model: Model, real: Real): void {
    const members = selectionMembers(real.selection)
    if (members.length === 0 || real.gesture.kind !== 'idle') return
    if (nodeById(real.canvas, members[0]) === undefined) return
    const step = this.large ? 32 : 8
    const moves = members.flatMap((id) => {
      const node = nodeById(real.canvas, id)
      return node === undefined
        ? []
        : [
            {
              kind: 'move-node' as const,
              id: node.id,
              x: node.x + this.delta.dx * step,
              y: node.y + this.delta.dy * step,
            },
          ]
    })
    if (moves.length === 0) return
    dispatchCommands(real, [{ kind: 'batch', commands: moves }], this.toString())
    real.stats.nudges += 1
  }
  toString(): string {
    return `nudge(${this.delta.dx},${this.delta.dy}${this.large ? ',large' : ''})`
  }
}

/** Cmd+D. Reminted copies become the new selection. */
class Duplicate implements fc.Command<Model, Real> {
  check(): boolean {
    return true
  }
  run(_model: Model, real: Real): void {
    const members = selectionMembers(real.selection)
    if (members.length === 0) return
    const fragment = extractClipboardFragment(real.canvas, new Set(members))
    const command = buildFragmentInsertCommand(real.canvas, fragment, () => `dup-${real.nextId++}`)
    if (command === undefined) return
    const before = real.canvas
    dispatchCommands(real, [command], this.toString())
    if (real.canvas === before) return
    const reminted =
      command.kind === 'batch'
        ? command.commands.flatMap((c) => (c.kind === 'create-node' ? [c.node.id] : []))
        : []
    if (reminted.length > 0) {
      real.selection = reduceSelection(real.selection, { type: 'set-members', ids: reminted })
      real.stats.duplicates += 1
      settle(real)
    }
  }
  toString(): string {
    return 'duplicate'
  }
}

/** The bracket keys: bring forward / send backward / to front / to back. */
class Reorder implements fc.Command<Model, Real> {
  constructor(private readonly placement: 'forward' | 'backward' | 'front' | 'back') {}
  check(): boolean {
    return true
  }
  run(_model: Model, real: Real): void {
    const members = selectionMembers(real.selection)
    if (members.length === 0) return
    const before = real.canvas
    dispatchCommands(
      real,
      [{ kind: 'reorder-nodes', ids: members, placement: this.placement }],
      this.toString(),
    )
    if (real.canvas === before) return
    real.stats.reordersEffective += 1
    if (this.placement === 'forward' || this.placement === 'backward') {
      real.stats.stepReordersEffective += 1
    }
  }
  toString(): string {
    return `reorder(${this.placement})`
  }
}

/**
 * Cmd+Shift+L. The primary's current state decides the direction for the
 * whole selection, and LOCKING clears it — then the lock effect settles,
 * which is where the coupling back into gesture and selection lives.
 */
class ToggleLock implements fc.Command<Model, Real> {
  check(): boolean {
    return true
  }
  run(_model: Model, real: Real): void {
    const members = selectionMembers(real.selection)
    if (members.length === 0) return
    const next = !real.lockedNodeIds.has(members[0])
    for (const id of members) {
      if (next) real.lockedNodeIds.add(id)
      else real.lockedNodeIds.delete(id)
    }
    if (next) {
      real.selection = reduceSelection(real.selection, { type: 'clear' })
      real.stats.locksApplied += 1
    }
    real.trail.push(this.toString())
    settle(real)
  }
  toString(): string {
    return 'toggleLock'
  }
}

/**
 * Press a node, then replace the canvas out from under the resulting
 * gesture — the exact arrangement the S1 defect needed, drawn directly
 * instead of stumbled into.
 *
 * It earns its own command because the pool keeps growing: with fifteen
 * command kinds a mid-gesture replacement happened 9-19 times per 300
 * runs, and adding the keyboard half diluted that to 4-13. The
 * arrangement that found a real bug must not get rarer every time the
 * model learns a new operation.
 */
class PressThenReplace implements fc.Command<Model, Real> {
  constructor(
    private readonly index: number,
    private readonly keep: readonly boolean[],
    private readonly external: boolean,
  ) {}
  check(): boolean {
    return true
  }
  run(model: Model, real: Real): void {
    const node = pick(real, this.index)
    if (node === undefined) return
    pressNode(real, node.id, { x: node.x, y: node.y }, this.toString())
    new ReplaceCanvas(this.keep, this.external).run(model, real)
  }
  toString(): string {
    return `pressThenReplace(#${this.index},${this.external ? 'external' : 'local'})`
  }
}

/**
 * Select one node, then press a z-order key.
 *
 * Its own command for the same reason `PressThenReplace` is: reorder is
 * only observable on a PROPER SUBSET of the document, and Cmd+A — the
 * cheapest way for a random sequence to acquire a selection — makes the
 * selection the whole canvas, where every placement is a no-op. Drawn
 * uniformly the effective-reorder count sat at 4 per 300 runs.
 */
class PressThenReorder implements fc.Command<Model, Real> {
  constructor(
    private readonly index: number,
    private readonly placement: 'forward' | 'backward' | 'front' | 'back',
  ) {}
  check(): boolean {
    return true
  }
  run(model: Model, real: Real): void {
    const node = pick(real, this.index)
    if (node === undefined) return
    pressNode(real, node.id, { x: node.x, y: node.y }, this.toString())
    new Reorder(this.placement).run(model, real)
  }
  toString(): string {
    return `pressThenReorder(#${this.index},${this.placement})`
  }
}

/**
 * Select one node, then press an arrow key — the click-then-nudge a user
 * actually performs. Its own command because the arrows need BOTH a
 * selection and an idle gesture, a conjunction a uniform draw reaches
 * rarely and erratically: nudges ranged 3-17 per 300 runs without it,
 * which is too few for the floor to distinguish variance from a generator
 * that stopped reaching the handler.
 */
class PressThenNudge implements fc.Command<Model, Real> {
  constructor(
    private readonly index: number,
    private readonly delta: { readonly dx: number; readonly dy: number },
    private readonly large: boolean,
  ) {}
  check(): boolean {
    return true
  }
  run(model: Model, real: Real): void {
    const node = pick(real, this.index)
    if (node === undefined) return
    pressNode(real, node.id, { x: node.x, y: node.y }, this.toString())
    // The press leaves a `moving` gesture and the arrows only fire while
    // idle, exactly as the handler requires — so release it first, as the
    // finger does.
    dispatch(real, { type: 'pointerup', point: { x: node.x, y: node.y } }, `${this.toString()}:up`)
    new Nudge(this.delta, this.large).run(model, real)
  }
  toString(): string {
    return `pressThenNudge(#${this.index},${this.delta.dx},${this.delta.dy})`
  }
}

const indexArb = fc.nat({ max: 3 })
const pointArb: fc.Arbitrary<Point> = fc.record({
  x: fc.integer({ min: -40, max: 300 }),
  y: fc.integer({ min: -40, max: 240 }),
})
const handleArb = fc.constantFrom<ResizeHandleKind>('nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w')
const arrowArb = fc.constantFrom(
  { dx: 0, dy: -1 },
  { dx: 0, dy: 1 },
  { dx: -1, dy: 0 },
  { dx: 1, dy: 0 },
)

/** Never (0, 0): a zero-delta drag is a select, and commits nothing. */
const nonZeroDeltaArb: fc.Arbitrary<Point> = fc
  .tuple(fc.integer({ min: -60, max: 60 }), fc.integer({ min: -60, max: 60 }))
  .filter(([x, y]) => x !== 0 || y !== 0)
  .map(([x, y]) => ({ x, y }))

const allCommands = [
  fc.tuple(indexArb, pointArb).map(([i, p]) => new PressNode(i, p)),
  fc
    .tuple(indexArb, handleArb, pointArb, fc.boolean())
    .map(([i, h, p, multi]) => new PressHandle(i, h, p, multi)),
  indexArb.map((i) => new PressConnect(i)),
  fc.constant(new PressEmpty()),
  pointArb.map((p) => new Move(p)),
  fc.tuple(pointArb, fc.option(indexArb, { nil: null })).map(([p, over]) => new Release(p, over)),
  fc.constant(new Cancel()),
  pointArb.map((p) => new DoubleClickEmpty(p)),
  indexArb.map((i) => new StartTextEdit(i)),
  // Non-empty on purpose: an empty "typed" string is indistinguishable from
  // never having typed, and T1 has nothing to say about it.
  fc.string({ minLength: 1, maxLength: 6 }).map((t) => new TypeText(t)),
  fc.constant(new CommitTextEdit()),
  fc.constant(new CancelTextEdit()),
  fc.constant(new DeleteSelection()),
  indexArb.map((i) => new ToggleMember(i)),
  fc
    .tuple(
      fc.array(fc.boolean(), { minLength: NODE_IDS.length, maxLength: NODE_IDS.length }),
      fc.boolean(),
    )
    .map(([keep, external]) => new ReplaceCanvas(keep, external)),
  fc
    .tuple(indexArb, pointArb, nonZeroDeltaArb)
    .map(([i, from, delta]) => new DragNode(i, from, delta)),
  fc
    .tuple(indexArb, handleArb, pointArb, nonZeroDeltaArb)
    .map(([i, h, from, delta]) => new ResizeNode(i, h, from, delta)),
  fc.tuple(indexArb, indexArb).map(([a, b]) => new ConnectNodes(a, b)),
  fc.constant(new SelectAll()),
  fc.tuple(arrowArb, fc.boolean()).map(([d, large]) => new Nudge(d, large)),
  fc.constant(new Duplicate()),
  fc
    .constantFrom<'forward' | 'backward' | 'front' | 'back'>('forward', 'backward', 'front', 'back')
    .map((p) => new Reorder(p)),
  fc.constant(new ToggleLock()),
  fc
    .tuple(
      indexArb,
      fc.array(fc.boolean(), { minLength: NODE_IDS.length, maxLength: NODE_IDS.length }),
      fc.boolean(),
    )
    .map(([i, keep, external]) => new PressThenReplace(i, keep, external)),
  fc
    .tuple(
      indexArb,
      fc.constantFrom<'forward' | 'backward' | 'front' | 'back'>(
        'forward',
        'backward',
        'front',
        'back',
      ),
    )
    .map(([i, p]) => new PressThenReorder(i, p)),
  fc
    .tuple(indexArb, arrowArb, fc.boolean())
    .map(([i, d, large]) => new PressThenNudge(i, d, large)),
]

describe('editor composite state (command-based)', () => {
  const stats: Stats = {
    moveCommits: 0,
    resizeCommits: 0,
    connectCommits: 0,
    deletes: 0,
    textEditsOpened: 0,
    pendingTextHandoffs: 0,
    externalReplacementsMidGesture: 0,
    multiSelections: 0,
    nudges: 0,
    duplicates: 0,
    reordersEffective: 0,
    stepReordersEffective: 0,
    locksApplied: 0,
    selectAlls: 0,
  }

  /**
   * The fixture reached its subject. Every invariant here is about an
   * ARRANGEMENT — a commit landing, an edit handed off, a node vanishing
   * under a live gesture — and a generator that drifted away from those
   * would keep passing while covering only presses that resolve to nothing.
   */
  afterAll(() => {
    // Floors, not sentinels. `> 0` passes on a generator that reached an
    // arrangement once by luck, which is the shape this guard exists to
    // reject. Each sits well under the minimum measured across six
    // consecutive runs — moves 49-80, resizes 55-68, connects 31-39,
    // deletes 27-46, text edits opened 87-104, pending-text handoffs
    // 20-33, mid-gesture external replacements 35-48, multi-selections
    // 163-205, nudges 56-93, duplicates 20-32, effective reorders 28-46
    // (of which forward/backward 11-23), locks applied 14-28, select-alls
    // 52-63.
    //
    // Two rules, both learned by getting them wrong here. Count EFFECTS,
    // not attempts: `reorders` counted attempts and read as green while
    // forward/backward were doing nothing at all. And re-measure when
    // adding a command or widening the document generator, because both
    // dilute every existing counter — the keyboard half took mid-gesture
    // external replacements from 9-19 to 4-13, and generating four node
    // types quartered the text-node share the T1 invariant feeds on.
    // Three arrangements were dense enough to need a command of their own
    // rather than a lowered floor.
    expect(stats.moveCommits, 'moves barely committed').toBeGreaterThan(25)
    expect(stats.resizeCommits, 'resizes barely committed').toBeGreaterThan(25)
    expect(stats.connectCommits, 'edges barely connected').toBeGreaterThan(15)
    expect(stats.deletes, 'nodes barely deleted').toBeGreaterThan(10)
    expect(stats.textEditsOpened, 'text edits barely opened').toBeGreaterThan(40)
    expect(stats.pendingTextHandoffs, 'open edits barely left with text in them').toBeGreaterThan(
      10,
    )
    expect(
      stats.externalReplacementsMidGesture,
      'external replacements barely landed mid-gesture',
    ).toBeGreaterThan(15)
    expect(stats.multiSelections, 'multi-selection barely reached').toBeGreaterThan(50)
    expect(stats.nudges, 'arrow-key nudges barely reached').toBeGreaterThan(25)
    expect(stats.duplicates, 'Cmd+D barely reached').toBeGreaterThan(8)
    expect(stats.reordersEffective, 'z-order barely changed anything').toBeGreaterThan(12)
    expect(
      stats.stepReordersEffective,
      'forward/backward never stepped over an overlapping node',
    ).toBeGreaterThan(5)
    expect(stats.locksApplied, 'Cmd+Shift+L barely locked anything').toBeGreaterThan(6)
    expect(stats.selectAlls, 'Cmd+A barely reached').toBeGreaterThan(25)
  })

  fcTest.prop(
    [initialCanvasArb, fc.commands(allCommands, { maxCommands: 24 })],
    withDefaults({ numRuns: 300 }),
  )(
    'canvas, gesture and selection stay mutually coherent under any operation sequence',
    (startCanvas, commands) => {
      fc.modelRun(
        () => ({
          model: {} as Model,
          real: {
            canvas: startCanvas,
            gesture: createIdleState(),
            selection: EMPTY_SELECTION,
            lockedNodeIds: new Set<string>(),
            nextId: 0,
            trail: [],
            stats,
          } satisfies Real,
        }),
        commands,
      )
    },
  )
})

/**
 * The shrunk counterexamples, pinned per the PBT guideline. The property is
 * the generator that found these; these are the regression guards.
 *
 * Pinning is not ceremony here — it is what the search measured. Against the
 * unfixed `start-text-edit`, five consecutive runs of the property went red
 * and a sixth passed, because `fc.commands` draws a fresh seed each run and
 * the arrangement is only usually reached. A guard that fires five times in
 * six is not a guard.
 */
describe('pinned counterexamples', () => {
  // [press(#0), replaceCanvas(local, keep=0000)] — the selection outlived
  // the node it named. Invisible at every read site (each filters by
  // laid-out box) right up until Delete, whose branches are gated on the
  // primary having a box: two surviving extras keep drawing their outlines
  // while the key does nothing.
  it('a canvas replacement that drops the selected node clears it from the selection', () => {
    const canvas = initialCanvas()
    const press = reduceGesture(createIdleState(), canvas, {
      type: 'pointerdown',
      nodeId: 'n0',
      point: { x: 10, y: 10 },
    })
    const selected = reduceSelection(EMPTY_SELECTION, {
      type: 'set-primary',
      id: press.selectedId ?? null,
    })
    expect(selectionMembers(selected)).toEqual(['n0'])

    // The replacement drops every node — an undo back to an empty canvas.
    const missingIds = new Set(canvas.nodes.map((node) => node.id))
    expect(
      selectionMembers(reduceSelection(selected, { type: 'drop-missing', missingIds })),
    ).toEqual([])
  })

  it('drop-missing promotes a surviving extra when the primary is the node that vanished', () => {
    const state: SelectionState = { primaryId: 'n0', extraIds: new Set(['n1', 'n2']) }
    const after = reduceSelection(state, { type: 'drop-missing', missingIds: new Set(['n0']) })
    expect(after.primaryId).toBe('n1')
    expect([...after.extraIds]).toEqual(['n2'])
  })

  it('drop-missing returns the same object when nothing selected has vanished', () => {
    const state: SelectionState = { primaryId: 'n0', extraIds: new Set(['n1']) }
    expect(reduceSelection(state, { type: 'drop-missing', missingIds: new Set(['n9']) })).toBe(
      state,
    )
  })

  // [startTextEdit(text#0), startTextEdit(text#1)] — the context menu's
  // "Edit text" verb on a second node while the first is open. The shrunk
  // case loses text identical to what is stored; typing first is the same
  // transition with a user-visible loss, so that is what this pins.
  it('opening a text edit on another node commits the text typed into the current one', () => {
    const canvas = initialCanvas()
    const opened = reduceGesture(createIdleState(), canvas, {
      type: 'start-text-edit',
      nodeId: 'n0',
      text: 'zero',
    })
    const typed = reduceGesture(opened.state, canvas, {
      type: 'update-text-edit',
      text: 'zero, edited',
    })
    const moved = reduceGesture(typed.state, canvas, {
      type: 'start-text-edit',
      nodeId: 'n1',
      text: 'one',
    })

    expect(moved.commands).toEqual([{ kind: 'set-text', id: 'n0', text: 'zero, edited' }])
    expect(moved.state).toEqual({ kind: 'editing-text', nodeId: 'n1', pendingText: 'one' })
    expect(applyCommand(canvas, moved.commands[0]).nodes[0]).toMatchObject({
      id: 'n0',
      text: 'zero, edited',
    })
  })

  it('re-opening the edit on the SAME node re-seeds without committing', () => {
    const canvas = initialCanvas()
    const opened = reduceGesture(createIdleState(), canvas, {
      type: 'start-text-edit',
      nodeId: 'n0',
      text: 'zero',
    })
    const typed = reduceGesture(opened.state, canvas, {
      type: 'update-text-edit',
      text: 'zero, edited',
    })
    const again = reduceGesture(typed.state, canvas, {
      type: 'start-text-edit',
      nodeId: 'n0',
      text: 'zero',
    })
    expect(again.commands).toEqual([])
    expect(again.state).toEqual({ kind: 'editing-text', nodeId: 'n0', pendingText: 'zero' })
  })
})
