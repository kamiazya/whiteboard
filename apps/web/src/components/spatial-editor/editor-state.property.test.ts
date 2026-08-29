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
 * re-checks C1/G1/S1/T1 against the real state, so a violation is reported
 * at the step that introduced it with the whole trail attached.
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
import type { SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import { afterAll, describe, expect, it } from 'vitest'
import { fc, fcTest, withDefaults } from '../../test-utils/fast-check.js'
import { applyCommand, type EditorCommand } from './commands.js'
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
 * Four nodes at fixed, overlapping-free positions — small enough that a
 * random sequence keeps landing on the SAME node (which is what makes
 * press-then-press, edit-then-edit and delete-then-drag reachable), and
 * mixed in type so the reducer's text-only arms are exercised against a
 * node that is not text.
 */
const POOL: readonly SpatialNode[] = [
  { id: 'n0', type: 'text', x: 0, y: 0, width: 100, height: 60, text: 'zero' },
  { id: 'n1', type: 'text', x: 160, y: 0, width: 100, height: 60, text: 'one' },
  { id: 'n2', type: 'text', x: 0, y: 120, width: 100, height: 60, text: '' },
  { id: 'n3', type: 'link', x: 160, y: 120, width: 100, height: 60, url: 'https://example.com/' },
]

function initialCanvas(): SpatialCanvas {
  return {
    nodes: [...POOL],
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
}

interface Real {
  canvas: SpatialCanvas
  gesture: GestureState
  selection: SelectionState
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
  checkInvariants(real)
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

/** Resolves a generated index against whatever nodes are still live. */
function pick(real: Real, index: number): SpatialNode | undefined {
  if (real.canvas.nodes.length === 0) return undefined
  return real.canvas.nodes[index % real.canvas.nodes.length]
}

function pickText(real: Real, index: number): SpatialNode | undefined {
  const texts = real.canvas.nodes.filter((node) => node.type === 'text')
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
  event(real: Real): GestureEvent | undefined {
    const node = pick(real, this.index)
    if (node === undefined) return undefined
    return { type: 'pointerdown', nodeId: node.id, point: this.point }
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

class CancelTextEdit extends GestureCommand {
  event(): GestureEvent {
    return { type: 'cancel-text-edit' }
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
      checkInvariants(real)
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
    checkInvariants(real)
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
    checkInvariants(real)
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
    dispatch(real, { type: 'pointerdown', nodeId: node.id, point: this.from }, this.toString())
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

const indexArb = fc.nat({ max: 3 })
const pointArb: fc.Arbitrary<Point> = fc.record({
  x: fc.integer({ min: -40, max: 300 }),
  y: fc.integer({ min: -40, max: 240 }),
})
const handleArb = fc.constantFrom<ResizeHandleKind>('nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w')
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
    .tuple(fc.array(fc.boolean(), { minLength: 4, maxLength: 4 }), fc.boolean())
    .map(([keep, external]) => new ReplaceCanvas(keep, external)),
  fc
    .tuple(indexArb, pointArb, nonZeroDeltaArb)
    .map(([i, from, delta]) => new DragNode(i, from, delta)),
  fc
    .tuple(indexArb, handleArb, pointArb, nonZeroDeltaArb)
    .map(([i, h, from, delta]) => new ResizeNode(i, h, from, delta)),
  fc.tuple(indexArb, indexArb).map(([a, b]) => new ConnectNodes(a, b)),
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
    // reject. Each floor sits well under the minimum measured across seven
    // consecutive runs — moves 74-107, resizes 70-117, connects 50-75,
    // deletes 21-42, text edits opened 131-162, pending-text handoffs
    // 40-56, mid-gesture external replacements 9-19, multi-selections
    // 59-83 — so ordinary seed variance never trips them, and a drift big
    // enough to hollow the property out fails here before the invariants
    // start passing vacuously.
    expect(stats.moveCommits, 'moves barely committed').toBeGreaterThan(30)
    expect(stats.resizeCommits, 'resizes barely committed').toBeGreaterThan(30)
    expect(stats.connectCommits, 'edges barely connected').toBeGreaterThan(20)
    expect(stats.deletes, 'nodes barely deleted').toBeGreaterThan(8)
    expect(stats.textEditsOpened, 'text edits barely opened').toBeGreaterThan(50)
    expect(stats.pendingTextHandoffs, 'open edits barely left with text in them').toBeGreaterThan(
      15,
    )
    expect(
      stats.externalReplacementsMidGesture,
      'external replacements barely landed mid-gesture',
    ).toBeGreaterThan(3)
    expect(stats.multiSelections, 'multi-selection barely reached').toBeGreaterThan(20)
  })

  fcTest.prop([fc.commands(allCommands, { maxCommands: 24 })], withDefaults({ numRuns: 300 }))(
    'canvas, gesture and selection stay mutually coherent under any operation sequence',
    (commands) => {
      fc.modelRun(
        () => ({
          model: {} as Model,
          real: {
            canvas: initialCanvas(),
            gesture: createIdleState(),
            selection: EMPTY_SELECTION,
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
