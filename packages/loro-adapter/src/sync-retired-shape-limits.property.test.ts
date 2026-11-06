/**
 * The judge refuses an update exactly when it leaves a retired shape standing
 * that the record did not hold: accept implies nothing is newly retired, and
 * refuse implies something is. The oracle reads whole states — a plain import
 * of the update into a fork, then each shape's reader over every key the
 * generator can name — so it shares no operation-scoped machinery with the
 * judge it checks.
 */
import { LoroDoc, LoroMovableList } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { CANVAS_KEY, EDGES_KEY, NODES_KEY, RETIRED_COMMENTS_KEY } from './containers.js'
import { retiredCanvasShape, retiredEdgeShape, retiredNodeShape } from './retired-stored-shape.js'
import { importWithinTextLimits } from './sync-text-limits.js'
import { fc, withDefaults } from './test-utils/fast-check.js'
import { createWorkspaceDocumentAtPath, documentContainers } from './workspace-tree.js'

const BOARD = '01RSPAAAAAAAAAAAAAAAAAAAA0'
// One id, so an update lands on a pair the record holds as often as on a fresh one.
const IDS = ['a'] as const

type Op =
  | { readonly kind: 'node' | 'edge'; readonly id: string; readonly retired: boolean }
  | { readonly kind: 'unset-node' | 'unset-edge' | 'unset-comment'; readonly id: string }
  | { readonly kind: 'canvas'; readonly retired: boolean }
  | { readonly kind: 'comment'; readonly id: string }
  | { readonly kind: 'push-element' | 'clear-elements' | 'unset-canvas' }

const id = fc.constantFrom(...IDS)
const writes: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constantFrom('node', 'edge'), id, retired: fc.constant(true) }),
  fc.record({ kind: fc.constant('canvas'), retired: fc.constant(true) }),
  fc.record({ kind: fc.constant('comment'), id }),
  fc.record({ kind: fc.constant('push-element') }),
) as fc.Arbitrary<Op>
const others: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constantFrom('node', 'edge'), id, retired: fc.constant(false) }),
  fc.record({ kind: fc.constantFrom('unset-node', 'unset-edge', 'unset-comment'), id }),
  fc.record({ kind: fc.constant('canvas'), retired: fc.constant(false) }),
  fc.record({ kind: fc.constantFrom('clear-elements', 'unset-canvas') }),
) as fc.Arbitrary<Op>
const op: fc.Arbitrary<Op> = fc.oneof({ weight: 3, arbitrary: writes }, others)

/** The step that undoes a retired write. */
function repairOf(step: Op): Op {
  switch (step.kind) {
    case 'node':
      return { kind: 'unset-node', id: step.id }
    case 'edge':
      return { kind: 'unset-edge', id: step.id }
    case 'comment':
      return { kind: 'unset-comment', id: step.id }
    case 'canvas':
      return { kind: 'unset-canvas' }
    default:
      return { kind: 'clear-elements' }
  }
}

const ops = fc.array(op, { maxLength: 3 })

/**
 * What the record holds and what the update does to it. Three archetypes
 * beside the free draw, so that 25 runs reach each outcome — an update that
 * rewrites a held shape, one that repairs it, one that writes a new one —
 * rather than hoping the free draw lands on a shared pair.
 */
const scenario: fc.Arbitrary<readonly [readonly Op[], readonly Op[]]> = fc.oneof(
  fc.tuple(ops, ops).map(([seeded, steps]) => [seeded, [...steps, ...seeded]] as const),
  fc.tuple(writes, ops, ops).map(
    ([w, seeded, steps]) =>
      [
        [w, ...seeded],
        [w, ...steps],
      ] as const,
  ),
  fc.tuple(writes, ops, ops).map(
    ([w, seeded, steps]) =>
      [
        [w, ...seeded],
        [repairOf(w), ...steps],
      ] as const,
  ),
  fc.tuple(writes, ops).map(([w, seeded]) => [seeded, [w]] as const),
)

const elementsList = (doc: LoroDoc): LoroMovableList => {
  const node = doc
    .getTree('tree')
    .getNodes()
    .find((candidate) => candidate.data.get('documentId') === BOARD)
  if (node === undefined) throw new Error('the board is gone')
  const held = node.data.get('elements')
  return held instanceof LoroMovableList
    ? held
    : node.data.setContainer('elements', new LoroMovableList())
}

function apply(doc: LoroDoc, step: Op): void {
  const board = documentContainers(doc, BOARD)
  switch (step.kind) {
    case 'node':
      board
        .getMap(NODES_KEY)
        .set(step.id, step.retired ? { id: step.id, 'x-whiteboard': {} } : { id: step.id, n: 1 })
      break
    case 'edge':
      board
        .getMap(EDGES_KEY)
        .set(step.id, step.retired ? { id: step.id, 'x-whiteboard': {} } : { id: step.id, n: 1 })
      break
    case 'unset-node':
      board.getMap(NODES_KEY).delete(step.id)
      break
    case 'unset-edge':
      board.getMap(EDGES_KEY).delete(step.id)
      break
    case 'canvas':
      board.getMap(CANVAS_KEY).set(step.retired ? 'x-whiteboard' : 'tags', { a: 1 })
      break
    case 'unset-canvas':
      board.getMap(CANVAS_KEY).delete('x-whiteboard')
      break
    case 'comment':
      board.getMap(RETIRED_COMMENTS_KEY).set(step.id, { id: step.id })
      break
    case 'unset-comment':
      board.getMap(RETIRED_COMMENTS_KEY).delete(step.id)
      break
    case 'push-element':
      elementsList(doc).push({ id: 'el' })
      break
    case 'clear-elements': {
      const list = elementsList(doc)
      if (list.length > 0) list.delete(0, list.length)
      break
    }
  }
}

/** How much of each retired shape a state holds, by what holds it. */
function retiredIn(doc: LoroDoc): Map<string, number> {
  const board = documentContainers(doc, BOARD)
  const held = new Map<string, number>()
  for (const key of IDS) {
    if (retiredNodeShape(key, board.getMap(NODES_KEY).get(key)) !== null) held.set(`node ${key}`, 1)
    if (retiredEdgeShape(key, board.getMap(EDGES_KEY).get(key)) !== null) held.set(`edge ${key}`, 1)
    if (board.getMap(RETIRED_COMMENTS_KEY).get(key) !== undefined) held.set(`comment ${key}`, 1)
  }
  if (retiredCanvasShape(board.getMap(CANVAS_KEY)) !== null) held.set('canvas', 1)
  const elements = elementsList(doc).length
  if (elements > 0) held.set('elements', elements)
  return held
}

const reached = { replayed: 0, refused: 0, repaired: 0 }

/** The pair a step writes a retired shape into, when it does. */
function writtenPair(step: Op): string | null {
  switch (step.kind) {
    case 'node':
    case 'edge':
      return step.retired ? `${step.kind} ${step.id}` : null
    case 'comment':
      return `comment ${step.id}`
    case 'canvas':
      return step.retired ? 'canvas' : null
    case 'push-element':
      return 'elements'
    default:
      return null
  }
}

describe('the retired-shape judgement', () => {
  it('refuses an update exactly when it leaves a retired shape the record did not hold', () => {
    fc.assert(
      fc.property(scenario, ([seeded, steps]) => {
        const base = new LoroDoc()
        createWorkspaceDocumentAtPath(base, { path: 'board', documentId: BOARD, kind: 'spatial' })
        for (const step of seeded) apply(base, step)
        base.commit()
        const client = base.fork()
        const from = client.oplogVersion()
        for (const step of steps) apply(client, step)
        client.commit()
        const update = client.export({ mode: 'update', from })

        const after = base.fork()
        after.import(update)
        const before = retiredIn(base.fork())
        const now = retiredIn(after)
        const newlyRetired = [...now].some(([key, weight]) => weight > (before.get(key) ?? 0))

        const { breach } = importWithinTextLimits(base.fork(), update)

        expect(breach !== null).toBe(newlyRetired)
        if (breach !== null) reached.refused += 1
        else if (steps.some((step) => before.has(writtenPair(step) ?? ''))) reached.replayed += 1
        if ([...before].some(([key]) => !now.has(key)) && breach === null) reached.repaired += 1
      }),
      withDefaults({ numRuns: 25 }),
    )
    // A property over updates that are never refused, or never accepted
    // beside a held shape it rewrote, would pass while asserting nothing.
    expect(reached.refused).toBeGreaterThan(0)
    expect(reached.replayed).toBeGreaterThan(0)
    expect(reached.repaired).toBeGreaterThan(0)
  })
})
