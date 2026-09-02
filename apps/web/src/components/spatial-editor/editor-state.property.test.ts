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
import {
  clearClipboardFragmentForTests,
  readClipboardFragment,
  recordedReconnection,
  recordReconnection,
  writeClipboardFragment,
} from '../../lib/clipboard-store.js'
import { assertLedger, emptyTally, type SurfaceCoverage } from '../../test-utils/coverage-ledger.js'
import { fc, fcTest, withDefaults } from '../../test-utils/fast-check.js'
import {
  applyCommand,
  buildFragmentInsertCommand,
  DUPLICATE_OFFSET_PX,
  type EditorCommand,
} from './commands.js'
import type { Box, ResizeHandleKind } from './geometry.js'
import { carriedByGesture } from './gesture-view.js'
import {
  createIdleState,
  type GestureEvent,
  type GestureResult,
  type GestureState,
  reduceGesture,
} from './gestures.js'
import { groupEnclosure } from './node-factories.js'
import {
  EMPTY_SELECTION,
  reduceSelection,
  type SelectionState,
  selectionMembers,
} from './selection.js'
import type { ShortcutId } from './shortcuts.js'
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

/**
 * The three ledgers below are what keeps this file honest as the editor
 * grows: each rides on a closed union the editor already maintains, so
 * ADDING A MEMBER FAILS THE BUILD until someone writes down which it is.
 * A new `EditorCommand` kind is what "added a feature to the canvas"
 * almost always means, and without this the property stays green while
 * covering none of it — the exact vacuity the effect-counters were
 * introduced to catch one layer down.
 *
 * The four-direction contract and the reason it has to be four lives with
 * the helper (`test-utils/coverage-ledger.ts`); when a ledger is worth
 * writing at all is `.claude/rules/coverage-ledger.md`.
 *
 * A fourth ledger lives in `editor-state-surface.test.ts`, covering the
 * one surface here that is not a union: every piece of React state
 * `SpatialEditor` holds. It scans the source instead of riding on the
 * type system, but carries the same both-sides contract.
 */

/**
 * Every canvas mutation the editor can perform. The uncovered half is
 * uniform in shape: single-property writes from an inspector panel, a
 * dialog or a context-menu item, which change one field of one element
 * and touch neither the gesture state machine nor the selection. They are
 * worth covering the day one of them starts interacting with either.
 */
const COMMAND_COVERAGE = {
  batch: 'covered',
  'move-node': 'covered',
  'resize-node': 'covered',
  'set-text': 'covered',
  'connect-nodes': 'covered',
  'create-node': 'covered',
  'delete-node': 'covered',
  'create-edge': 'covered',
  'delete-edge': 'covered',
  'reorder-nodes': 'covered',
  'set-body':
    'not modelled: the markdown editor writes the document body, which is not in the canvas at all — applyCommand returns the same reference',
  'set-facets':
    'not modelled: the document properties panel writes core facets, likewise outside the canvas',
  'set-edge-label':
    'not modelled: edge label editor, a single-field write with no gesture or selection coupling',
  'set-edge-ends': 'not modelled: edge inspector, single-field write',
  'set-edge-side': 'not modelled: edge inspector, single-field write',
  'set-edge-color': 'not modelled: edge inspector, single-field write',
  'set-edge-routing': 'not modelled: a canvas-wide preference, not per-element state',
  'set-line-jumps': 'not modelled: a canvas-wide preference, not per-element state',
  'set-node-color': 'not modelled: node inspector, single-field write',
  'set-node-facet': 'not modelled: facet panel, a plugin-owned payload with its own tests',
  'set-node-file': 'not modelled: file picker dialog, single-field write',
  'set-node-url': 'not modelled: link URL dialog, single-field write',
  'create-group': 'covered',
  'set-group-label': 'not modelled: group label editor, single-field write',
  'set-group-background': 'not modelled: group inspector, single-field write',
  'create-comment':
    "not modelled: no comment UI is wired yet (ADR-0024's apps/web interactive-comment-UI follow-up increment, named in its 'This increment' section); the command has no gesture or selection coupling to model here — covered at the applyCommand/session layers instead",
  'set-comment-resolved':
    "not modelled: no comment UI is wired yet (ADR-0024's apps/web interactive-comment-UI follow-up increment), single-field write",
  'delete-comment':
    "not modelled: no comment UI is wired yet (ADR-0024's apps/web interactive-comment-UI follow-up increment)",
} satisfies Record<EditorCommand['kind'], SurfaceCoverage>

/** Every event the gesture state machine accepts. All of them are driven. */
const GESTURE_EVENT_COVERAGE = {
  pointerdown: 'covered',
  'pointerdown-handle': 'covered',
  'pointerdown-connect': 'covered',
  'pointerdown-empty': 'covered',
  'dblclick-empty': 'covered',
  'delete-selection': 'covered',
  pointermove: 'covered',
  pointerup: 'covered',
  pointercancel: 'covered',
  'canvas-replaced': 'covered',
  'start-text-edit': 'covered',
  'update-text-edit': 'covered',
  'commit-text-edit': 'covered',
  'cancel-text-edit': 'covered',
} satisfies Record<GestureEvent['type'], SurfaceCoverage>

/**
 * Every keyboard binding in `shortcuts.ts`, the editor's single catalog.
 * The uncovered five are the viewport family, which cannot reach canvas,
 * gesture or selection state — `viewport.property.test.ts` owns them.
 */
const SHORTCUT_COVERAGE = {
  'select-all': 'covered',
  'duplicate-selection': 'covered',
  'copy-selection': 'covered',
  'cut-selection': 'covered',
  'paste-clipboard': 'covered',
  'reorder-forward': 'covered',
  'reorder-backward': 'covered',
  'reorder-front': 'covered',
  'reorder-back': 'covered',
  'delete-selection': 'covered',
  // The overlay editors' commit. Cmd+Enter and a blur both reach the
  // reducer through the same `commit-text-edit`, so the model drives the
  // binding even though it never synthesises the keystroke.
  'commit-text-edit': 'covered',
  'toggle-lock': 'covered',
  'nudge-selection': 'covered',
  cancel: 'covered',
  'zoom-in': 'not modelled: viewport only — cannot reach canvas, gesture or selection state',
  'zoom-out': 'not modelled: viewport only',
  'zoom-to-fit': 'not modelled: viewport only',
  'zoom-to-selection': 'not modelled: viewport only',
  'space-pan': 'not modelled: viewport only',
} satisfies Record<ShortcutId, SurfaceCoverage>

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
  edgeSelections: number
  edgeDeletes: number
  copies: number
  cuts: number
  /** Pastes that resolved as a same-canvas MOVE of the held originals. */
  cutMoves: number
  /** Pastes that inserted reminted copies. */
  pasteInserts: number
  /** Inserts that reconnected at least one severed boundary edge. */
  reconnections: number
  marqueeSelections: number
  handPressesIgnored: number
  handEntries: number
  connectArms: number
  toolSwitches: number
  /** Move commits that carried at least one node besides the grabbed one. */
  carriedMoves: number
  groupOrMultiDrags: number
  /** Drags of a GROUP frame that carried at least one contained node. */
  groupFrameDrags: number
  groupsCreated: number
  /**
   * Per-member tallies behind the three ledgers above. Emissions, not
   * effects — the question these answer is "does the model ever produce
   * this at all", which is about the model's REACH. Whether what it
   * produced then did anything is the separate question the effect
   * counters answer.
   */
  commandKinds: Record<EditorCommand['kind'], number>
  eventTypes: Record<GestureEvent['type'], number>
  shortcutIds: Record<ShortcutId, number>
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
  /**
   * The selected EDGE. Separate state from the node selection, and unlike
   * it, not behind a reducer: `SpatialEditor` writes this from eighteen
   * call sites, each responsible for keeping the two coherent by hand.
   * That is the arrangement `selection.ts` exists to have replaced for
   * nodes.
   */
  selectedEdgeId: string | null
  /**
   * A cut holds its originals rather than deleting them, until a paste
   * decides what the cut meant — a move here, a copy elsewhere, or
   * nothing. The snapshot is the frozen JSON of each held node, which is
   * what the invalidation effect compares against.
   */
  pendingCut: { readonly cutId: string; readonly snapshot: ReadonlyMap<string, string> } | null
  /**
   * Which tool is active. Not decoration: `hand` returns from
   * `handlePointerDown` before any gesture or selection work happens at
   * all, and `connect` re-routes a node press to `pointerdown-connect`
   * instead of starting a move.
   */
  tool: 'select' | 'hand' | 'connect'
  /**
   * The rubber-band rectangle, armed by a press that hit no node. While
   * it is armed the pointer NEVER reaches the gesture reducer again —
   * `pointermove` and `pointerup` both branch to the marquee and return —
   * so this is not an extra layer over the gesture path but a fork away
   * from it.
   */
  marquee: { readonly start: Point; readonly current: Point } | null
  nextId: number
  trail: string[]
  stats: Stats
}

/** The invariants are the oracle; nothing needs a shadow copy of the state. */
type Model = Record<string, never>

/** Applies a command and tallies its kind, recursing into a batch. */
function applyAndCount(real: Real, command: EditorCommand): void {
  tallyCommand(real, command)
  real.canvas = applyCommand(real.canvas, command)
}

function tallyCommand(real: Real, command: EditorCommand): void {
  real.stats.commandKinds[command.kind] += 1
  if (command.kind === 'batch') for (const inner of command.commands) tallyCommand(real, inner)
}

/**
 * Whether a shortcut declaring `tools: ['select']` would fire.
 *
 * `findShortcut` takes the tool and refuses a spec the current tool is
 * not listed in, so half the catalog is inert outside select mode:
 * select-all, the clipboard family, duplicate, the z-order brackets and
 * the lock toggle. The four inline-handled bindings — Delete, Escape, the
 * arrows and Space — declare no `tools` and stay live in every tool,
 * which is why they are not gated here.
 */
function inSelectTool(real: Real): boolean {
  return real.tool === 'select'
}

/** Records that a command exercised the keyboard binding it stands for. */
function tallyShortcut(real: Real, id: ShortcutId): void {
  real.stats.shortcutIds[id] += 1
}

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

  // E1: node selection and edge selection are mutually exclusive. Stated
  // as a comment at two call sites — "Delete processes a selected edge
  // FIRST, so an edge left selected here would be what a Delete on the
  // node multi-selection actually removes" — and maintained by hand at
  // all eighteen `setSelectedEdgeId` writes.
  if (real.selectedEdgeId !== null) {
    expect(selectionMembers(selection), `E1 both selections non-empty ${at}`).toEqual([])
  }

  // E2: the selected edge still exists. This is S1 for the other half of
  // the selection, and unlike S1 there is no effect watching it — nothing
  // in the component compares `selectedEdgeId` against `canvas.edges`.
  if (real.selectedEdgeId !== null) {
    expect(
      canvas.edges.some((edge) => edge.id === real.selectedEdgeId),
      `E2 selected edge ${real.selectedEdgeId} is gone ${at}`,
    ).toBe(true)
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
  // The pending-cut invalidation effect: anyone touching a held node —
  // a local drag, a remote edit, a delete — lifts the hold, because the
  // veil must never dim a node that changed under it. Keyed on `canvas`,
  // so like the lock effect it runs after every step.
  if (real.pendingCut !== null) {
    const held = real.pendingCut.snapshot
    const touched = [...held].some(([id, frozen]) => {
      const node = real.canvas.nodes.find((n) => n.id === id)
      return node === undefined || JSON.stringify(node) !== frozen
    })
    if (touched) real.pendingCut = null
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
  if (stillEditingSameNode) {
    // Staying in the SAME edit is not automatically safe, and treating it
    // as such is what hid a loss here: `start-text-edit` on the node
    // already being edited re-seeded `pendingText` from the canvas,
    // silently replacing what had been typed. Only a keystroke may change
    // it, so every other event that leaves the edit open must leave the
    // text alone.
    if (event.type !== 'update-text-edit') {
      expect(
        real.gesture.kind === 'editing-text' ? real.gesture.pendingText : undefined,
        `T1 ${event.type} changed the open edit's text without a keystroke after ${real.trail.join(' → ')}`,
      ).toBe(before.pendingText)
    }
    return
  }
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
function dispatch(
  real: Real,
  event: GestureEvent,
  label: string,
  /**
   * `handlePointerUp`'s commit-time expansion, threaded in rather than
   * applied afterwards so a result and its followers reach `applyResult`
   * as ONE list — which is what makes them one undo step.
   */
  expand?: (real: Real, before: GestureState, result: GestureResult) => readonly EditorCommand[],
): void {
  real.stats.eventTypes[event.type] += 1
  const before = real.gesture
  const raw = reduceGesture(real.gesture, real.canvas, event, {
    createId: () => `made-${real.nextId++}`,
  })
  const result: GestureResult =
    expand === undefined ? raw : { ...raw, commands: expand(real, before, raw) }
  real.gesture = result.state
  if (result.selectedId !== undefined) {
    real.selection = reduceSelection(real.selection, { type: 'set-primary', id: result.selectedId })
    // A node becoming primary retires any edge selection — see the same
    // rule in `applyResult`, and its note on why `null` is excluded.
    if (result.selectedId !== null) real.selectedEdgeId = null
  }
  for (const command of result.commands) applyAndCount(real, command)
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
  for (const command of commands) applyAndCount(real, command)
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
  // Hand mode is navigation only: the handler returns before any of this,
  // so a press changes nothing at all.
  if (real.tool === 'hand') {
    real.stats.handPressesIgnored += 1
    return
  }
  real.selection = reduceSelection(real.selection, { type: 'press', id: nodeId })
  real.selectedEdgeId = null
  if (real.tool === 'connect') {
    // The connect tool arms from a node press instead of starting a move,
    // and a press while already connecting is swallowed — the edge
    // completes on the pointerup over the target.
    if (real.gesture.kind !== 'connecting') {
      real.stats.connectArms += 1
      dispatch(real, { type: 'pointerdown-connect', nodeId }, `${label}:connectTool`)
    }
    return
  }
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

/** A selectable node with at least one edge, or any selectable node. */
function pickConnected(real: Real, index: number): SpatialNode | undefined {
  const touched = new Set(real.canvas.edges.flatMap((edge) => [edge.fromNode, edge.toNode]))
  const connected = real.canvas.nodes.filter(
    (node) => touched.has(node.id) && !real.lockedNodeIds.has(node.id),
  )
  if (connected.length === 0) return pick(real, index)
  return connected[index % connected.length]
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

/**
 * A press that hits no node. It either lands on an EDGE line — which
 * selects that edge — or on true empty space, which clears both
 * selections. Mirrors `handlePointerDown`'s `hitId === undefined` branch,
 * including its `collapse-extras` before the reducer's own clear.
 */
class PressEmpty implements fc.Command<Model, Real> {
  constructor(
    private readonly onEdgeIndex: number | null,
    private readonly at: Point,
  ) {}
  check(): boolean {
    return true
  }
  run(_model: Model, real: Real): void {
    if (real.tool === 'hand') {
      real.stats.handPressesIgnored += 1
      return
    }
    const edges = real.canvas.edges
    const hitEdge =
      this.onEdgeIndex === null || edges.length === 0
        ? undefined
        : edges[this.onEdgeIndex % edges.length]
    // The press ARMS the rubber band, whether it landed on empty space or
    // on an edge line — an edge press that turns into a drag was a marquee
    // all along, and the release drops the edge selection it made here.
    real.marquee = { start: this.at, current: this.at }
    real.selection = reduceSelection(real.selection, { type: 'collapse-extras' })
    real.selectedEdgeId = hitEdge?.id ?? null
    if (hitEdge !== undefined) real.stats.edgeSelections += 1
    dispatch(real, { type: 'pointerdown-empty' }, this.toString())
  }
  toString(): string {
    return this.onEdgeIndex === null ? 'pressEmpty' : `pressEdge(#${this.onEdgeIndex})`
  }
}

class Move implements fc.Command<Model, Real> {
  constructor(private readonly point: Point) {}
  check(): boolean {
    return true
  }
  run(_model: Model, real: Real): void {
    // An armed marquee takes the move and RETURNS — the reducer never sees
    // it. Mirrored rather than layered, because the two paths are
    // exclusive in the handler too.
    if (real.marquee !== null) {
      real.marquee = { start: real.marquee.start, current: this.point }
      real.trail.push(this.toString())
      settle(real)
      return
    }
    dispatch(real, { type: 'pointermove', point: this.point }, this.toString())
  }
  toString(): string {
    return `move(${this.point.x},${this.point.y})`
  }
}

class Release implements fc.Command<Model, Real> {
  constructor(
    private readonly point: Point,
    private readonly overIndex: number | null,
  ) {}
  check(): boolean {
    return true
  }
  run(_model: Model, real: Real): void {
    releasePointer(real, this.point, this.overIndex, this.toString())
  }
  toString(): string {
    return `release(${this.point.x},${this.point.y}${this.overIndex === null ? '' : `,over#${this.overIndex}`})`
  }
}

/**
 * One pointer release, branching as `handlePointerUp` does: an armed
 * marquee resolves to an area selection and the reducer is never
 * consulted; anything else goes to the reducer's `pointerup`.
 */
function releasePointer(real: Real, point: Point, overIndex: number | null, label: string): void {
  const marquee = real.marquee
  if (marquee !== null) {
    real.marquee = null
    if (marquee.start.x === point.x && marquee.start.y === point.y) {
      // A stationary press. The click paths it resolves to (double-press
      // create, tap-to-place paste, edge label edit) have their own
      // commands; nothing selection-shaped happens here.
      real.trail.push(`${label}:click`)
      settle(real)
      return
    }
    const rect = {
      x: Math.min(marquee.start.x, point.x),
      y: Math.min(marquee.start.y, point.y),
      w: Math.abs(point.x - marquee.start.x),
      h: Math.abs(point.y - marquee.start.y),
    }
    // `selectableBoxes` again: a marquee may not gather a locked node.
    const hitIds = real.canvas.nodes
      .filter(
        (node) =>
          !real.lockedNodeIds.has(node.id) &&
          node.x < rect.x + rect.w &&
          node.x + node.width > rect.x &&
          node.y < rect.y + rect.h &&
          node.y + node.height > rect.y,
      )
      .map((node) => node.id)
    real.selection = reduceSelection(real.selection, { type: 'set-members', ids: hitIds })
    // A drag that began on an edge line was a marquee, not an edge click.
    real.selectedEdgeId = null
    if (hitIds.length > 0) real.stats.marqueeSelections += 1
    real.trail.push(`${label}:marquee`)
    settle(real)
    return
  }
  const over = overIndex === null ? undefined : pick(real, overIndex)
  dispatch(
    real,
    { type: 'pointerup', point, ...(over === undefined ? {} : { targetNodeId: over.id }) },
    label,
    expandCarriedMoves,
  )
}

/**
 * The reducer keeps a single-node contract, so a move that carries other
 * nodes is expanded HERE, at commit time, exactly as `handlePointerUp`
 * does — through the same `carriedByGesture` the ghost, the snapping and
 * the live layers already share. Two things ride on that set: a
 * multi-selection's extras, and a grabbed GROUP frame's geometrically
 * contained members, minus any that are locked.
 *
 * The model went without this for a long time and was wrong for it: a
 * dragged multi-selection moved only the node under the pointer, so every
 * arrangement built on "drag a group of things" was really testing a
 * single-node drag.
 */
function expandCarriedMoves(
  real: Real,
  before: GestureState,
  result: GestureResult,
): readonly EditorCommand[] {
  const moved = result.commands.find((command) => command.kind === 'move-node')
  if (moved === undefined || before.kind !== 'moving') return result.commands
  const dx = moved.x - before.startX
  const dy = moved.y - before.startY
  const carried = carriedByGesture(real.canvas, before, real.selection.extraIds, (id) =>
    real.lockedNodeIds.has(id),
  )
  const followers = [...carried]
    .filter((id) => id !== moved.id)
    .flatMap((id) => {
      const node = nodeById(real.canvas, id)
      return node === undefined
        ? []
        : [{ kind: 'move-node' as const, id, x: node.x + dx, y: node.y + dy }]
    })
  if (followers.length === 0) return result.commands
  real.stats.carriedMoves += 1
  if (carried.size > 1) real.stats.groupOrMultiDrags += 1
  // Counted separately, and with its own floor, because G2 cannot see
  // this rule break: G2 says the carried set moves rigidly, and a
  // containment test that stopped finding members would shrink that set,
  // which still moves rigidly.
  //
  // It has to count what CONTAINMENT contributed, not what the frame
  // carried. The first version of this counter fired whenever a group was
  // dragged with anything else selected, so the selection extras kept it
  // green with containment disabled outright — measured, and the reason
  // the subtraction below is here rather than a `type === 'group'` check.
  const fromExtras = new Set([moved.id, ...real.selection.extraIds])
  if ([...carried].some((id) => !fromExtras.has(id))) real.stats.groupFrameDrags += 1
  return [...result.commands, ...followers]
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
    tallyShortcut(real, 'commit-text-edit')
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
    if (real.gesture.kind === 'idle') return undefined
    tallyShortcut(real, 'cancel')
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
    if (real.gesture.kind === 'editing-text') return
    tallyShortcut(real, 'delete-selection')
    // The edge branch comes FIRST in `handleKeyDown` and returns, so a
    // selected edge consumes the key whether or not it still exists.
    if (real.selectedEdgeId !== null) {
      const edgeId = real.selectedEdgeId
      real.selectedEdgeId = null
      dispatchCommands(real, [{ kind: 'delete-edge', id: edgeId }], `deleteEdge(${edgeId})`)
      real.stats.edgeDeletes += 1
      return
    }
    const members = selectionMembers(real.selection).filter((id) => liveIds(real.canvas).has(id))
    if (members.length === 0) return
    if (real.selection.extraIds.size > 0) {
      const before = real.gesture
      const result = {
        state: { kind: 'idle' } as GestureState,
        commands: members.map((id) => ({ kind: 'delete-node', id }) as const),
        selectedId: null,
      }
      real.gesture = result.state
      real.selection = reduceSelection(real.selection, { type: 'set-primary', id: null })
      for (const command of result.commands) applyAndCount(real, command)
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
    real.selectedEdgeId = null
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
    const heldEdges = new Set(replacement.edges.map((edge) => edge.id))
    const missingEdges = new Set(
      real.canvas.edges.map((edge) => edge.id).filter((id) => !heldEdges.has(id)),
    )
    if (this.external && real.gesture.kind !== 'idle') {
      real.stats.externalReplacementsMidGesture += 1
    }
    // The layout effect feeds the reducer the replacement and takes its
    // answer; the canvas prop itself is the new one either way.
    const before = real.gesture
    real.stats.eventTypes['canvas-replaced'] += 1
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
    if (real.selectedEdgeId !== null && missingEdges.has(real.selectedEdgeId)) {
      real.selectedEdgeId = null
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
/**
 * G2: a drag is a RIGID motion of everything it carries. Whatever
 * `carriedByGesture` names — the grabbed node, the selection extras, a
 * group frame's contained members — lands at exactly one shared delta.
 *
 * Stated over the commit rather than the preview, because the two are
 * separate code (`liveNodesFor` draws, `expandCarriedMoves` writes) and
 * the failure this guards is them disagreeing: the ghost showing a group
 * travelling and the drop leaving half of it behind.
 */
function checkRigidMotion(
  real: Real,
  before: SpatialCanvas,
  carried: ReadonlySet<string>,
  label: string,
): void {
  const deltas = [...carried].flatMap((id) => {
    const was = before.nodes.find((n) => n.id === id)
    const now = nodeById(real.canvas, id)
    return was === undefined || now === undefined ? [] : [`${now.x - was.x},${now.y - was.y}`]
  })
  expect(new Set(deltas).size, `G2 carried set did not move rigidly after ${label}`).toBeLessThan(2)
}

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
    const gesture = real.gesture
    const carried =
      gesture.kind === 'moving'
        ? carriedByGesture(real.canvas, gesture, real.selection.extraIds, (id) =>
            real.lockedNodeIds.has(id),
          )
        : new Set<string>()
    const before = real.canvas
    dispatch(real, { type: 'pointermove', point: to }, `${this.toString()}:move`)
    releasePointer(real, to, null, `${this.toString()}:up`)
    if (carried.size > 0) checkRigidMotion(real, before, carried, this.toString())
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
    releasePointer(real, to, null, `${this.toString()}:up`)
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
    if (!inSelectTool(real)) return
    const ids = real.canvas.nodes.map((node) => node.id).filter((id) => !real.lockedNodeIds.has(id))
    if (ids.length === 0) return
    real.selection = reduceSelection(real.selection, { type: 'set-members', ids })
    real.selectedEdgeId = null
    real.trail.push(this.toString())
    tallyShortcut(real, 'select-all')
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
    tallyShortcut(real, 'nudge-selection')
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
    if (!inSelectTool(real)) return
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
      real.selectedEdgeId = null
      tallyShortcut(real, 'duplicate-selection')
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
    if (!inSelectTool(real)) return
    const members = selectionMembers(real.selection)
    if (members.length === 0) return
    // The ledger tally goes with the KEY PRESS, not with the effect. The
    // two answer different questions and this one had them crossed:
    // pressing `]` on a block already at the front exercises the binding
    // even though the canvas does not move, and tallying after the
    // early-return made one of the four placements read as uncovered in
    // one run of four. The effect counters below stay where they are.
    tallyShortcut(real, `reorder-${this.placement}`)
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
    if (!inSelectTool(real)) return
    const members = selectionMembers(real.selection)
    if (members.length === 0) return
    tallyShortcut(real, 'toggle-lock')
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
    releasePointer(real, { x: node.x, y: node.y }, null, `${this.toString()}:up`)
    new Nudge(this.delta, this.large).run(model, real)
  }
  toString(): string {
    return `pressThenNudge(#${this.index},${this.delta.dx},${this.delta.dy})`
  }
}

/**
 * Select an edge, then do one thing to it — press Delete, or let a canvas
 * replacement take it away.
 *
 * Needed for the same reason as the other composites: an edge selection is
 * cleared by almost every node-touching command, so drawn uniformly it
 * survived to a Delete 1-3 times per 300 runs out of 24-43 selections.
 * The replacement arm is the one that can leave the selection naming an
 * edge the document no longer holds — nothing watches `selectedEdgeId`
 * against `canvas.edges`.
 */
class PressEdgeThen implements fc.Command<Model, Real> {
  constructor(
    private readonly edgeIndex: number,
    private readonly then: 'delete' | 'replace',
    private readonly keep: readonly boolean[],
    private readonly external: boolean,
  ) {}
  check(): boolean {
    return true
  }
  run(model: Model, real: Real): void {
    if (real.canvas.edges.length === 0) return
    new PressEmpty(this.edgeIndex, { x: 0, y: 0 }).run(model, real)
    if (real.selectedEdgeId === null) return
    if (this.then === 'delete') new DeleteSelection().run(model, real)
    else new ReplaceCanvas(this.keep, this.external).run(model, real)
  }
  toString(): string {
    return `pressEdgeThen${this.then === 'delete' ? 'Delete' : 'Replace'}(#${this.edgeIndex})`
  }
}

/**
 * The clipboard family — Cmd+C / Cmd+X / Cmd+V. Three more pieces of
 * state than the rest of the surface put together, and the only ones that
 * live OUTSIDE the component: a module-scoped fragment slot, a
 * module-scoped record of which edges each cut's reconnection created,
 * and the component's own `pendingCut` hold.
 *
 * The module-scoped halves are why `clearClipboardFragmentForTests` runs
 * in the setup below. `fc.commands` replays the same setup for every
 * generated sequence and again for every shrink step; state surviving
 * between them would make a counterexample depend on the runs before it,
 * which is exactly the shape that cannot be reproduced from a seed.
 *
 * A cut does NOT delete. It holds the originals until a paste decides what
 * it meant — a move here (same canvas, matching cut id: the held nodes
 * keep their ids and only change place, so every edge survives without
 * reconnection machinery), a copy elsewhere, or nothing.
 */
class Copy implements fc.Command<Model, Real> {
  check(): boolean {
    return true
  }
  run(_model: Model, real: Real): void {
    if (!inSelectTool(real)) return
    const members = selectionMembers(real.selection)
    if (members.length === 0) return
    const fragment = extractClipboardFragment(real.canvas, new Set(members))
    if (fragment.nodes.length === 0) return
    writeClipboardFragment(fragment)
    // The newest clipboard intent wins: a plain copy lifts a pending cut.
    real.pendingCut = null
    tallyShortcut(real, 'copy-selection')
    real.stats.copies += 1
    real.trail.push(this.toString())
    settle(real)
  }
  toString(): string {
    return 'copy'
  }
}

class Cut implements fc.Command<Model, Real> {
  check(): boolean {
    return true
  }
  run(_model: Model, real: Real): void {
    if (!inSelectTool(real)) return
    const members = selectionMembers(real.selection)
    if (members.length === 0) return
    const cutId = `cut-${real.nextId++}`
    const fragment = extractClipboardFragment(real.canvas, new Set(members), { cutId })
    if (fragment.nodes.length === 0 || fragment.cut === undefined) return
    writeClipboardFragment(fragment)
    real.pendingCut = {
      cutId: fragment.cut.id,
      snapshot: new Map(fragment.nodes.map((node) => [node.id, JSON.stringify(node)])),
    }
    tallyShortcut(real, 'cut-selection')
    real.stats.cuts += 1
    real.trail.push(this.toString())
    settle(real)
  }
  toString(): string {
    return 'cut'
  }
}

class Paste implements fc.Command<Model, Real> {
  constructor(private readonly at: Point | null) {}
  check(): boolean {
    return true
  }
  run(_model: Model, real: Real): void {
    if (!inSelectTool(real)) return
    const fragment = readClipboardFragment()
    if (fragment === null) return
    tallyShortcut(real, 'paste-clipboard')
    const current = real.canvas
    const at = this.at ?? undefined

    // A paste answering THIS canvas's pending cut is a MOVE.
    if (fragment.cut !== undefined && real.pendingCut?.cutId === fragment.cut.id) {
      const snapshot = real.pendingCut.snapshot
      const held = current.nodes.filter((node) => snapshot.has(node.id))
      if (held.length > 0) {
        let dx = DUPLICATE_OFFSET_PX
        let dy = DUPLICATE_OFFSET_PX
        if (at !== undefined) {
          const minX = Math.min(...held.map((node) => node.x))
          const minY = Math.min(...held.map((node) => node.y))
          const maxX = Math.max(...held.map((node) => node.x + node.width))
          const maxY = Math.max(...held.map((node) => node.y + node.height))
          dx = Math.round(at.x - (minX + maxX) / 2)
          dy = Math.round(at.y - (minY + maxY) / 2)
        }
        const moveCommand: EditorCommand = {
          kind: 'batch',
          commands: held.map((node) => ({
            kind: 'move-node' as const,
            id: node.id,
            x: node.x + dx,
            y: node.y + dy,
          })),
        }
        // Cleared BEFORE the command applies, so the move's own geometry
        // change does not race the invalidation effect above.
        real.pendingCut = null
        const before = current
        dispatchCommands(real, [moveCommand], `${this.toString()}:move`)
        if (real.canvas === before) return
        // P2: a cut-move is a MOVE. The held nodes keep their ids, so the
        // node set is untouched and no edge — internal or boundary — had
        // to be reconnected. A resolution that deleted and recreated them
        // would satisfy every other invariant here and silently break
        // every edge into the cut region.
        expect(
          new Set(real.canvas.nodes.map((n) => n.id)),
          `P2 cut-move changed the node set after ${real.trail.join(' → ')}`,
        ).toEqual(new Set(before.nodes.map((n) => n.id)))
        expect(
          real.canvas.edges.map((e) => e.id),
          `P2 cut-move changed the edges after ${real.trail.join(' → ')}`,
        ).toEqual(before.edges.map((e) => e.id))
        real.selection = reduceSelection(real.selection, {
          type: 'set-members',
          ids: held.map((node) => node.id),
        })
        real.selectedEdgeId = null
        real.stats.cutMoves += 1
        settle(real)
        return
      }
    }

    // The cut surface reconnects only while the document shows no trace of
    // a previous reconnection for this cut.
    const cut =
      fragment.cut !== undefined &&
      !recordedReconnection(fragment.cut.id).some((id) =>
        current.edges.some((edge) => edge.id === id),
      )
        ? fragment.cut
        : undefined
    const command = buildFragmentInsertCommand(
      current,
      { nodes: fragment.nodes, edges: fragment.edges, cut },
      () => `paste-${real.nextId++}`,
      at,
    )
    if (command === undefined) return
    const before = current
    dispatchCommands(real, [command], this.toString())
    // P3: a paste of a non-empty fragment INSERTS it. Ids are reminted
    // against the target canvas, so the node count grows by exactly the
    // fragment's size — no collision can silently swallow a node.
    // Worth stating because the failure is quiet: `create-node` returns
    // the input canvas for an id that already exists, so a paste that
    // stopped reminting would do nothing at all rather than corrupt
    // anything, and every other invariant here would stay green.
    expect(
      real.canvas.nodes.length,
      `P3 paste did not insert its fragment after ${real.trail.join(' → ')}`,
    ).toBe(before.nodes.length + fragment.nodes.length)
    if (cut !== undefined && command.kind === 'batch') {
      const createdNodeIds = new Set(
        command.commands.flatMap((c) => (c.kind === 'create-node' ? [c.node.id] : [])),
      )
      const boundary = command.commands.flatMap((c) =>
        c.kind === 'create-edge' &&
        (!createdNodeIds.has(c.edge.fromNode) || !createdNodeIds.has(c.edge.toNode))
          ? [c.edge.id]
          : [],
      )
      // P4: the cut surface reconnects only edges that were actually
      // severed. A boundary edge whose original is still on the canvas
      // was never cut — the hold was lifted some other way — and wiring
      // the peer again would leave it with two edges where the user sees
      // one.
      const severed = cut.boundaryEdges.filter(
        (edge) => !before.edges.some((existing) => existing.id === edge.id),
      )
      expect(
        boundary.length,
        `P4 reconnected more than was severed after ${real.trail.join(' → ')}`,
      ).toBeLessThanOrEqual(severed.length)
      recordReconnection(cut.id, boundary)
      if (boundary.length > 0) real.stats.reconnections += 1
    }
    const reminted =
      command.kind === 'batch'
        ? command.commands.flatMap((c) => (c.kind === 'create-node' ? [c.node.id] : []))
        : []
    if (reminted.length > 0) {
      real.selection = reduceSelection(real.selection, { type: 'set-members', ids: reminted })
      real.selectedEdgeId = null
    }
    real.stats.pasteInserts += 1
    settle(real)
  }
  toString(): string {
    return this.at === null ? 'paste' : `pasteAt(${this.at.x},${this.at.y})`
  }
}

/**
 * Select a node, then run one of the three clipboard flows on it. Drawn
 * directly for the reason every other composite here is: the steps must
 * land in order on a live selection, with nothing in between touching a
 * held node — which lifts the hold and changes which branch the paste
 * takes.
 *
 * The three modes reach three DIFFERENT branches, and the third is the
 * only route to the most intricate code in the clipboard:
 *
 * - `copy` → the insert branch, reminted ids, no cut surface.
 * - `cut` → the same-canvas MOVE branch, the pending-cut mechanism's
 *   whole reason to exist.
 * - `cutDelete` → the insert branch WITH a cut surface to reconnect. A
 *   cut defers its delete, so while the originals are still present the
 *   boundary loop skips every edge (`canvasEdgeIds.has(edge.id)`) and the
 *   reconnection code cannot run at all. Measured: 0 reconnections per
 *   300 runs before this mode existed.
 */
class ClipboardFlow implements fc.Command<Model, Real> {
  constructor(
    private readonly index: number,
    private readonly mode: 'copy' | 'cut' | 'cutDelete' | 'cutTouch',
    private readonly at: Point | null,
  ) {}
  check(): boolean {
    return true
  }
  run(model: Model, real: Real): void {
    // For `cutDelete` prefer a node that HAS an edge: the reconnection is
    // about the severed boundary, and cutting a lone node exercises none
    // of it. Falls back to any node, so the arm still runs on documents
    // where nothing is connected.
    const node =
      this.mode === 'cutDelete' ? pickConnected(real, this.index) : pick(real, this.index)
    if (node === undefined) return
    pressNode(real, node.id, { x: node.x, y: node.y }, this.toString())
    releasePointer(real, { x: node.x, y: node.y }, null, `${this.toString()}:up`)
    if (this.mode === 'copy') {
      new Copy().run(model, real)
    } else {
      new Cut().run(model, real)
      if (this.mode === 'cutDelete') new DeleteSelection().run(model, real)
      // Nudging a held node lifts the hold without removing anything, so
      // the paste falls to the INSERT branch while the cut's boundary
      // edges are all still on the canvas — the only arrangement in which
      // the reconnect-once guard has anything to do.
      if (this.mode === 'cutTouch') new Nudge({ dx: 1, dy: 0 }, false).run(model, real)
    }
    new Paste(this.at).run(model, real)
  }
  toString(): string {
    return `clipboard:${this.mode}(#${this.index})`
  }
}

/**
 * The tool palette. Only `hand` clears anything, and it clears
 * everything: a surviving selection would keep Delete, the resize handles
 * and connect live, an open editor would keep accepting text, and an
 * armed connect could still complete — all edits in a mode whose contract
 * is that no press can change the canvas.
 */
class SwitchTool implements fc.Command<Model, Real> {
  constructor(private readonly next: 'select' | 'hand' | 'connect') {}
  check(): boolean {
    return true
  }
  run(_model: Model, real: Real): void {
    real.tool = this.next
    real.stats.toolSwitches += 1
    if (this.next === 'hand') {
      if (real.gesture.kind !== 'idle') {
        dispatch(real, { type: 'pointercancel' }, `${this.toString()}:cancel`)
      }
      real.selection = reduceSelection(real.selection, { type: 'clear' })
      real.selectedEdgeId = null
      real.marquee = null
      real.stats.handEntries += 1
    }
    real.trail.push(this.toString())
    settle(real)
  }
  toString(): string {
    return `tool(${this.next})`
  }
}

/**
 * Switch tool, then use the pointer in it — the two halves a user
 * performs together and a uniform draw almost never pairs. Without it the
 * connect tool armed 3-5 times per 300 runs and hand mode swallowed 3-10
 * presses, which is too few for a floor to tell a live path from a dead
 * one.
 *
 * The connect arm is the interesting half: it reaches `connecting`
 * through the TOOL rather than through the selection overlay's connect
 * handle, and completes on the release over the second node.
 */
class WithTool implements fc.Command<Model, Real> {
  constructor(
    private readonly tool: 'hand' | 'connect',
    private readonly from: number,
    private readonly to: number,
  ) {}
  check(): boolean {
    return true
  }
  run(model: Model, real: Real): void {
    new SwitchTool(this.tool).run(model, real)
    const from = pick(real, this.from)
    const to = pick(real, this.to)
    if (from === undefined || to === undefined) return
    pressNode(real, from.id, { x: from.x, y: from.y }, this.toString())
    releasePointer(real, { x: to.x, y: to.y }, this.to, `${this.toString()}:up`)
  }
  toString(): string {
    return `withTool(${this.tool},#${this.from}→#${this.to})`
  }
}

/**
 * Frame the current selection: a group node at the enclosing box plus
 * padding, which becomes the selection. The frame therefore CONTAINS what
 * it was made from, so a later drag of it carries them — the one
 * arrangement in which the containment rule has anything to do, and one a
 * random sequence would otherwise have to build by luck out of a palette
 * frame and nodes that happened to land inside it.
 */
class GroupSelection implements fc.Command<Model, Real> {
  check(): boolean {
    return true
  }
  run(_model: Model, real: Real): void {
    const members = selectionMembers(real.selection).flatMap((id) => {
      const node = nodeById(real.canvas, id)
      return node === undefined ? [] : [node]
    })
    const frame = groupEnclosure(members)
    if (frame === undefined) return
    const id = `group-${real.nextId++}`
    dispatchCommands(
      real,
      [{ kind: 'create-group', node: { id, type: 'group', ...frame } }],
      this.toString(),
    )
    real.selection = reduceSelection(real.selection, { type: 'set-primary', id })
    real.selectedEdgeId = null
    real.selection = reduceSelection(real.selection, { type: 'collapse-extras' })
    real.stats.groupsCreated += 1
    settle(real)
  }
  toString(): string {
    return 'groupSelection'
  }
}

/**
 * A drag that CARRIES something — the only kind in which the commit-time
 * expansion runs at all.
 *
 * Both routes to it are conjunctions a uniform draw does not reach: the
 * multi route needs the pressed node to already be a member (a press on a
 * non-member collapses the set, so a random index almost always drags
 * alone), and the group route needs the grabbed node to be a frame that
 * geometrically contains others. Measured: 0 carried moves per 300 runs
 * before this command existed, with the expansion freshly written and
 * every other counter healthy — which is exactly the arrangement the
 * effect counters exist to expose.
 */
class DragCarrying implements fc.Command<Model, Real> {
  constructor(
    private readonly mode: 'multi' | 'group',
    private readonly delta: Point,
  ) {}
  check(): boolean {
    return true
  }
  run(model: Model, real: Real): void {
    new SwitchTool('select').run(model, real)
    new SelectAll().run(model, real)
    if (this.mode === 'group') new GroupSelection().run(model, real)
    const members = selectionMembers(real.selection)
    const grabbed = members[0] === undefined ? undefined : nodeById(real.canvas, members[0])
    if (grabbed === undefined) return
    const from = { x: grabbed.x, y: grabbed.y }
    const to = { x: from.x + this.delta.x, y: from.y + this.delta.y }
    pressNode(real, grabbed.id, from, this.toString())
    const gesture = real.gesture
    if (gesture.kind !== 'moving') return
    const carried = carriedByGesture(real.canvas, gesture, real.selection.extraIds, (id) =>
      real.lockedNodeIds.has(id),
    )
    const before = real.canvas
    dispatch(real, { type: 'pointermove', point: to }, `${this.toString()}:move`)
    releasePointer(real, to, null, `${this.toString()}:up`)
    checkRigidMotion(real, before, carried, this.toString())
  }
  toString(): string {
    return `dragCarrying(${this.mode},+${this.delta.x},+${this.delta.y})`
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
  fc
    .tuple(fc.option(fc.nat({ max: 3 }), { nil: null }), pointArb)
    .map(([i, at]) => new PressEmpty(i, at)),
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
  fc
    .tuple(
      indexArb,
      fc.constantFrom<'delete' | 'replace'>('delete', 'replace'),
      fc.array(fc.boolean(), { minLength: NODE_IDS.length, maxLength: NODE_IDS.length }),
      fc.boolean(),
    )
    .map(([i, then, keep, external]) => new PressEdgeThen(i, then, keep, external)),
  fc.constant(new Copy()),
  fc.constant(new Cut()),
  fc.option(pointArb, { nil: null }).map((at) => new Paste(at)),
  fc
    .tuple(
      indexArb,
      fc.constantFrom<'copy' | 'cut' | 'cutDelete' | 'cutTouch'>(
        'copy',
        'cut',
        'cutDelete',
        'cutTouch',
      ),
      fc.option(pointArb, { nil: null }),
    )
    .map(([i, mode, at]) => new ClipboardFlow(i, mode, at)),
  // Weighted back toward `select`: hand mode makes every pointer command
  // inert by design, so an even draw would spend a third of the sequence
  // asserting that nothing happens.
  fc
    .oneof(
      { arbitrary: fc.constant('select' as const), weight: 2 },
      { arbitrary: fc.constantFrom('hand', 'connect' as const), weight: 2 },
    )
    .map((next) => new SwitchTool(next)),
  fc
    .tuple(fc.constantFrom<'hand' | 'connect'>('hand', 'connect'), indexArb, indexArb)
    .map(([t, from, to]) => new WithTool(t, from, to)),
  fc.constant(new GroupSelection()),
  fc
    .tuple(fc.constantFrom<'multi' | 'group'>('multi', 'group'), nonZeroDeltaArb)
    .map(([mode, delta]) => new DragCarrying(mode, delta)),
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
    edgeSelections: 0,
    edgeDeletes: 0,
    copies: 0,
    cuts: 0,
    cutMoves: 0,
    pasteInserts: 0,
    reconnections: 0,
    marqueeSelections: 0,
    handPressesIgnored: 0,
    handEntries: 0,
    connectArms: 0,
    toolSwitches: 0,
    carriedMoves: 0,
    groupOrMultiDrags: 0,
    groupFrameDrags: 0,
    groupsCreated: 0,
    commandKinds: emptyTally(COMMAND_COVERAGE),
    eventTypes: emptyTally(GESTURE_EVENT_COVERAGE),
    shortcutIds: emptyTally(SHORTCUT_COVERAGE),
  }

  /**
   * Everything below lives in `afterAll`, which vitest reports as a
   * failed SUITE rather than a failed test — the summary line still says
   * "6 passed" beside the failure, and only the exit code (verified: 1)
   * disagrees. CI keys on the exit code; a human skimming locally should
   * read the error, not the count.
   *
   * The fixture reached its subject. Every invariant here is about an
   * ARRANGEMENT — a commit landing, an edit handed off, a node vanishing
   * under a live gesture — and a generator that drifted away from those
   * would keep passing while covering only presses that resolve to nothing.
   */
  afterAll(() => {
    // The three surface ledgers, checked from both sides. These come
    // FIRST because they answer a different question from the floors
    // below: not "did the fixture reach the interesting arrangement" but
    // "does this model still know about the whole editor". A feature
    // added to the canvas fails the BUILD at the ledger's `satisfies`
    // before it ever reaches here; these assertions are what stop an
    // entry that compiles from being wrong.
    assertLedger('EditorCommand kind', COMMAND_COVERAGE, stats.commandKinds)
    assertLedger('GestureEvent type', GESTURE_EVENT_COVERAGE, stats.eventTypes)
    assertLedger('shortcut', SHORTCUT_COVERAGE, stats.shortcutIds)

    // Every floor failure prints the WHOLE census, not only the counter
    // that fell — because which one fell says almost nothing on its own.
    // A counter that dropped while the one it shares a branch with stayed
    // healthy is an unlucky ARRANGEMENT; a whole column that fell together
    // is a run that simply did less work. Those want opposite fixes — a
    // denser domain versus a bigger budget — and the message could not
    // tell them apart, so the reader has to reconstruct the other numbers
    // from somewhere else.
    //
    // Measured, on the run that occasioned this: separating those two
    // readings took THIRTY local runs of this file, to recover numbers the
    // failing run had already computed and thrown away.
    const census = () =>
      Object.entries(stats)
        .filter(([, value]) => typeof value === 'number')
        .map(([name, value]) => `${name}=${value}`)
        .join(' ')
    const atLeast = (actual: number, floor: number, wentWrong: string) =>
      expect(actual, `${wentWrong}\ncensus: ${census()}`).toBeGreaterThan(floor)

    // Floors, not sentinels. `> 0` passes on a generator that reached an
    // arrangement once by luck, which is the shape this guard exists to
    // reject. Each sits at roughly a third of the minimum measured across
    // five consecutive runs — moves 296-404, resizes 49-68, connects
    // 56-89, deletes 50-82, text edits opened 117-129, pending-text
    // handoffs 33-44, mid-gesture external replacements 39-54,
    // multi-selections 430-515, nudges 70-98, duplicates 18-30, effective
    // reorders 43-54 (of which forward/backward 16-24), locks applied
    // 15-28, select-alls 119-139, edge selections 83-95, edge deletes
    // 19-34, copies 33-46, cuts 53-72, cut-moves 13-20, paste-inserts
    // 38-59, reconnections 5-19 (see below), marquee selections 23-30,
    // hand-swallowed presses 53-70, hand entries 43-56, connect arms
    // 44-68, tool switches 185-220, carried moves 57-80, group-or-multi
    // drags 57-80, group-frame drags 27-40, groups created 53-65.
    //
    // Three rules, all learned by getting them wrong here.
    //
    // Count EFFECTS, not attempts, for "did this code run" — `reorders`
    // counted attempts and read as green while forward/backward were
    // doing nothing at all, because the fixture's nodes never overlapped.
    // But count ATTEMPTS for "does the model press this key": the
    // reorder shortcut tally was effect-gated and one of its four
    // placements read as uncovered in one run of four.
    //
    // Count the RIGHT effect. `groupFrameDrags` first counted any frame
    // dragged alongside a selection, which the extras kept green with
    // production containment disabled outright.
    //
    // FIVE RUNS IS NOT A SAMPLE for a rare conjunction. Every range above
    // was taken over five, which is ample for a counter in the hundreds
    // and badly wrong for one in single digits. `reconnections` needs a
    // cut whose selection straddles an edge, and then a paste — a deep
    // conjunction the generator reaches only a few times per 500 runs.
    // Re-measured over THIRTY runs it is 5-19 (mean 10.7), not the 8-13
    // five runs reported, and the floor derived from that understated
    // minimum was `> 2`. A CI run then produced 2 and went red.
    //
    // The floor is therefore re-derived by the SAME rule from the honest
    // minimum — a third of 5 — rather than the guard being weakened by
    // judgement. It still refuses the two states it exists to refuse: the
    // arrangement never reached, and reached once by luck.
    //
    // What is NOT yet established is why CI produced 2 when thirty local
    // runs produced nothing under 5. Both readings remain open — a run
    // that did less work, or this conjunction alone being unlucky — and
    // the census printed on failure is what will settle it the next time
    // one fires, without another thirty runs.
    //
    // Re-measure when adding a command, widening the document generator,
    // or making the model MORE faithful, because all three dilute every
    // existing counter. `numRuns` went 300 -> 500 when the command set
    // reached thirty kinds and two counters started landing ON their
    // floor: the arrangements were still being reached, so that was
    // variance rather than vacuity, and more runs is the honest lever for
    // variance. It costs about three seconds.
    atLeast(stats.moveCommits, 100, 'moves barely committed')
    atLeast(stats.resizeCommits, 18, 'resizes barely committed')
    atLeast(stats.connectCommits, 20, 'edges barely connected')
    atLeast(stats.deletes, 18, 'nodes barely deleted')
    atLeast(stats.textEditsOpened, 40, 'text edits barely opened')
    atLeast(stats.pendingTextHandoffs, 12, 'open edits barely left with text in them')
    atLeast(
      stats.externalReplacementsMidGesture,
      14,
      'external replacements barely landed mid-gesture',
    )
    atLeast(stats.multiSelections, 150, 'multi-selection barely reached')
    atLeast(stats.nudges, 25, 'arrow-key nudges barely reached')
    atLeast(stats.duplicates, 6, 'Cmd+D barely reached')
    atLeast(stats.reordersEffective, 15, 'z-order barely changed anything')
    atLeast(
      stats.stepReordersEffective,
      5,
      'forward/backward never stepped over an overlapping node',
    )
    atLeast(stats.locksApplied, 5, 'Cmd+Shift+L barely locked anything')
    atLeast(stats.selectAlls, 40, 'Cmd+A barely reached')
    atLeast(stats.edgeSelections, 28, 'edges barely ever selected')
    atLeast(stats.edgeDeletes, 6, 'selected edges barely ever deleted')
    atLeast(stats.copies, 11, 'Cmd+C barely reached')
    atLeast(stats.cuts, 18, 'Cmd+X barely reached')
    atLeast(stats.cutMoves, 4, 'no paste resolved as a same-canvas move')
    atLeast(stats.pasteInserts, 12, 'no paste inserted a copy')
    atLeast(stats.reconnections, 1, 'no cut surface was ever reconnected')
    atLeast(stats.marqueeSelections, 7, 'no marquee ever gathered a node')
    atLeast(stats.handPressesIgnored, 17, 'hand mode never swallowed a press')
    atLeast(stats.handEntries, 14, 'hand mode was never entered')
    atLeast(stats.connectArms, 14, 'the connect tool never armed')
    atLeast(stats.toolSwitches, 60, 'the tool never changed')
    atLeast(stats.carriedMoves, 18, 'no drag ever carried a second node')
    atLeast(stats.groupOrMultiDrags, 18, 'no group or multi-selection was ever dragged')
    atLeast(stats.groupFrameDrags, 9, 'a dragged group frame never carried anything it contained')
    atLeast(stats.groupsCreated, 17, 'no group frame was ever made from a selection')
  })

  fcTest.prop(
    [initialCanvasArb, fc.commands(allCommands, { maxCommands: 24 })],
    withDefaults({ numRuns: 500 }),
  )(
    'canvas, gesture and selection stay mutually coherent under any operation sequence',
    (startCanvas, commands) => {
      // The clipboard's slot and its reconnection record are MODULE
      // state, so they are reset per sequence. `fc.commands` replays this
      // setup for every generated sequence and again for every shrink
      // step; state surviving between them makes a counterexample depend
      // on the runs before it, which is exactly what cannot be reproduced
      // from a seed.
      const freshState = () => {
        clearClipboardFragmentForTests()
        return {
          model: {} as Model,
          real: {
            canvas: startCanvas,
            gesture: createIdleState(),
            selection: EMPTY_SELECTION,
            lockedNodeIds: new Set<string>(),
            selectedEdgeId: null,
            pendingCut: null,
            tool: 'select',
            marquee: null,
            nextId: 0,
            trail: [],
            stats,
          } satisfies Real,
        }
      }
      fc.modelRun(freshState, commands)
    },
    // An explicit budget, sized on a measurement rather than left at
    // vitest's 5000ms default, which this property has never fit inside.
    // Measured with the budget lifted: 5.22-5.27s, and the SAME 5.23-5.26s
    // at `5ceac722`, the commit that raised `numRuns` to 500 — so it was
    // over from the day it was written, on a machine slower than CI's. CI
    // passes it; what the default cost was a local full-suite run
    // reporting a failure that is purely this machine's speed, and a
    // failing-file count that changed between two runs of one tree.
    //
    // The lever is the budget, NOT `numRuns`: the coverage floors above
    // record that 300 left two counters sitting exactly ON their floor,
    // so cutting runs trades a spurious failure for a property that
    // asserts less. A pinned seed would be worse than either.
    15_000,
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

  // Re-opening the editor on the node ALREADY being edited is a no-op, and
  // this test used to pin the opposite. `event.text` is read from the
  // canvas, so re-seeding from it replaces what the user typed with the
  // last committed value and emits nothing — the same silent loss as the
  // different-node case above, in the one arm that was carved out of it.
  // Reachable the same way: right-click the node you are editing and pick
  // Edit text, which the right-click leaves open because it returns early
  // from `handlePointerDown`. Found by CodeRabbit on #1119.
  it('re-opening the edit on the SAME node keeps what was typed', () => {
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
    expect(again.state).toEqual({ kind: 'editing-text', nodeId: 'n0', pendingText: 'zero, edited' })
  })
})
