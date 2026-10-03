/**
 * Concurrent-replica convergence of the workspace record's LISTING
 * (dual-plane collapse).
 *
 * Reading the listing from the workspace record makes `readWorkspaceDocuments` the source every
 * surface lists from, so what it must guarantee is not "a tree looks like
 * the rows" but the CRDT claim underneath: two replicas that each applied
 * their own placement writes and then exchanged updates answer ONE
 * listing — same entries, same order, same shadowed marks, same pin list —
 * whichever direction the merge ran in.
 *
 * Model-based: random op sequences per replica, cross-merged. The example
 * tests in workspace-tree.test.ts pin what convergence DECIDES for two
 * named races; this pins that it always decides the same thing on both
 * sides.
 *
 * Both replicas draw from a pool that includes the SAME documents, seeded
 * before the fork. Pools that were disjoint made every race over one document
 * (a delete against a move, a pin against an unpin) impossible by
 * construction, and the property passed over the arrangements the CRDT
 * exists to resolve. `races` below counts the arrangements each run actually
 * reached, with a floor, so a generator change that stops producing them
 * fails by name instead of passing vacuously.
 */
import { LoroDoc } from 'loro-crdt'
import { afterAll, describe, expect } from 'vitest'
import { fc, fcTest, withDefaults } from './test-utils/fast-check.js'
import {
  createWorkspaceDocumentAtPath,
  deleteWorkspaceDocument,
  moveWorkspaceNodeToPath,
  readPinnedDocumentIds,
  readWorkspaceDocuments,
  resolveWorkspaceDocument,
  resolveWorkspaceDocumentById,
  setWorkspaceDocumentName,
  setWorkspacePinned,
  updateWorkspaceDocumentMeta,
} from './workspace-tree.js'

const PATHS = ['a', 'b', 'c', 'a/x', 'a/y', 'b/x'] as const

// Crockford-valid ULIDs. The shared ones exist in the base both replicas fork
// from; the own pool is per replica, so concurrent creates carry distinct ids
// the way two real peers' creates would.
const SHARED_IDS = [0, 1, 2].map((i) => `01ARZ3NDEKTSV4RRFFQ69G5FZ${i}`)
const SHARED_PATHS = ['a', 'b', 'a/x'] as const
const OWN_COUNT = 6

function ownIds(marker: 'A' | 'B'): string[] {
  return Array.from({ length: OWN_COUNT }, (_, i) => `01ARZ3NDEKTSV4RRFFQ69G5F${marker}${i}`)
}

const pathArb = fc.constantFrom(...PATHS)
// A move names a path, not an id, so reaching a shared document means naming
// where it starts out.
const moveFromArb = fc.oneof(
  { weight: 2, arbitrary: fc.constantFrom(...SHARED_PATHS) },
  { weight: 1, arbitrary: pathArb },
)
// An index into the shared documents followed by the replica's own: the
// targets of every op that acts on an existing document. Weighted toward the
// shared ones, because a race needs both replicas to land on the same
// document and a uniform draw over nine lands there too rarely to matter.
const targetArb = fc.oneof(
  { weight: 4, arbitrary: fc.nat({ max: SHARED_IDS.length - 1 }) },
  { weight: 1, arbitrary: fc.nat({ max: OWN_COUNT - 1 }).map((i) => SHARED_IDS.length + i) },
)
const opArb = fc.oneof(
  // A create mints a document, so it draws from the replica's own pool only:
  // two replicas creating one id would be a state the port never lets a peer
  // reach, and is not the race under test.
  {
    weight: 1,
    arbitrary: fc.record({
      op: fc.constant('create' as const),
      path: pathArb,
      idIndex: fc.nat({ max: OWN_COUNT - 1 }),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({ op: fc.constant('move' as const), from: moveFromArb, to: pathArb }),
  },
  {
    weight: 2,
    arbitrary: fc.record({ op: fc.constant('delete' as const), idIndex: targetArb }),
  },
  {
    weight: 6,
    arbitrary: fc.record({
      op: fc.constant('pin' as const),
      idIndex: targetArb,
      pinned: fc.boolean(),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      op: fc.constant('rename' as const),
      idIndex: targetArb,
      name: fc.constantFrom('x', 'y', undefined),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      op: fc.constant('stamp' as const),
      idIndex: targetArb,
      updatedAt: fc.integer({ min: 1, max: 1000 }),
    }),
  },
)
type Op = typeof opArb extends fc.Arbitrary<infer T> ? T : never

type Effect = 'create' | 'move' | 'delete' | 'pin' | 'unpin' | 'meta'
type Effects = ReadonlyMap<string, ReadonlySet<Effect>>
type Recorded = Map<string, Set<Effect>>
type Race = 'any' | 'deleteVs' | 'deleteVsMove' | 'pinBoth'

function record(effects: Recorded, id: string, effect: Effect): void {
  const seen = effects.get(id)
  if (seen === undefined) effects.set(id, new Set([effect]))
  else seen.add(effect)
}

function applyMove(doc: LoroDoc, op: Extract<Op, { op: 'move' }>, effects: Recorded): void {
  // moveWorkspaceNodeToPath documents that the CALLER pre-checks (the
  // port's index guards with isSelfOrDescendant before calling); a
  // locally-illegal self/descendant move throws in Loro and is not a
  // convergence question. Concurrent moves that only become cyclic
  // after the merge stay in — resolving those IS the tree's job.
  if (op.to === op.from || op.to.startsWith(`${op.from}/`)) return
  const moved = resolveWorkspaceDocument(doc, op.from)
  if (moveWorkspaceNodeToPath(doc, op.from, op.to) && moved !== null) {
    record(effects, moved.documentId, 'move')
  }
}

function applyPin(doc: LoroDoc, documentId: string, pinned: boolean, effects: Recorded): void {
  if (resolveWorkspaceDocumentById(doc, documentId) === null) return
  // Recorded only when the list changed: pinning what is pinned writes
  // nothing, so it cannot race with anything.
  const wasPinned = readPinnedDocumentIds(doc).includes(documentId)
  setWorkspacePinned(doc, documentId, pinned)
  if (pinned !== wasPinned) record(effects, documentId, pinned ? 'pin' : 'unpin')
}

/** Applies `ops` to `doc` and answers which document each one actually changed. */
function apply(doc: LoroDoc, ownPool: string[], ops: Op[]): Effects {
  const pool = [...SHARED_IDS, ...ownPool]
  const effects: Recorded = new Map()
  for (const op of ops) {
    if (op.op === 'create') {
      // Null (a document already owns the path) is a fine local refusal;
      // the interesting collisions are the CONCURRENT ones neither
      // replica could see coming.
      const documentId = ownPool[op.idIndex] as string
      const input = { path: op.path, documentId, kind: 'spatial' as const }
      if (createWorkspaceDocumentAtPath(doc, input) !== null) record(effects, documentId, 'create')
    } else if (op.op === 'move') {
      applyMove(doc, op, effects)
    } else {
      const documentId = pool[op.idIndex] as string
      const present = resolveWorkspaceDocumentById(doc, documentId) !== null
      if (op.op === 'pin') {
        applyPin(doc, documentId, op.pinned, effects)
      } else if (op.op === 'delete' && present) {
        deleteWorkspaceDocument(doc, { documentId })
        record(effects, documentId, 'delete')
      } else if (op.op === 'rename' && present) {
        setWorkspaceDocumentName(
          doc,
          op.name === undefined ? { documentId } : { documentId, name: op.name },
        )
        record(effects, documentId, 'meta')
      } else if (
        op.op === 'stamp' &&
        updateWorkspaceDocumentMeta(doc, documentId, { updatedAt: op.updatedAt })
      ) {
        record(effects, documentId, 'meta')
      }
    }
  }
  return effects
}

function hasAny(effects: ReadonlySet<Effect> | undefined, wanted: readonly Effect[]): boolean {
  return effects !== undefined && wanted.some((e) => effects.has(e))
}

/**
 * The same document changed on both sides, in a pairing the merge has to
 * resolve rather than just union. `any` is the weakest (two edits of one
 * document); a delete against any other write, and both replicas changing
 * one document's pin, are the races the tree's and the pin list's rules
 * exist for.
 */
function racesOf(a: Effects, b: Effects): Record<Race, boolean> {
  const result = { any: false, deleteVs: false, deleteVsMove: false, pinBoth: false }
  for (const [id, mine] of a) {
    const theirs = b.get(id)
    if (theirs === undefined) continue
    result.any = true
    const write: readonly Effect[] = ['move', 'pin', 'unpin', 'meta']
    if (
      (mine.has('delete') && hasAny(theirs, write)) ||
      (theirs.has('delete') && hasAny(mine, write))
    ) {
      result.deleteVs = true
    }
    if ((mine.has('delete') && theirs.has('move')) || (theirs.has('delete') && mine.has('move'))) {
      result.deleteVsMove = true
    }
    const pinWrite: readonly Effect[] = ['pin', 'unpin']
    if (hasAny(mine, pinWrite) && hasAny(theirs, pinWrite)) result.pinBoth = true
  }
  return result
}

// 200 cases take about 2s alone, which leaves the default 5s little room once
// the package's files run in parallel. Safe to widen: a slower machine cannot
// make a property pass, only decide whether it gets to finish.
const PROPERTY_TIMEOUT_MS = 30_000

// Fractions of the cases that reached each arrangement. Measured over 20 runs
// of 200: any 0.36-0.49 (mean 0.44), deleteVs 0.17-0.31 (mean 0.24),
// deleteVsMove 0.03-0.11 (mean 0.07), pinBoth 0.055-0.13 (mean 0.09). Each
// floor sits well under the lowest reading, so it trips on a generator that
// stopped producing the race and not on a lean draw.
const FLOORS = { any: 0.2, deleteVs: 0.1, deleteVsMove: 0.01, pinBoth: 0.03 }

const races: Record<Race | 'cases', number> = {
  cases: 0,
  any: 0,
  deleteVs: 0,
  deleteVsMove: 0,
  pinBoth: 0,
}

describe('workspace-record listing convergence (S5a)', () => {
  fcTest.prop(
    [fc.array(opArb, { maxLength: 8 }), fc.array(opArb, { maxLength: 8 })],
    withDefaults(),
  )(
    'two replicas converge on one listing, pin list, and meta',
    (opsA: Op[], opsB: Op[]) => {
      const base = new LoroDoc()
      base.setPeerId(1n)
      SHARED_IDS.forEach((documentId, i) => {
        createWorkspaceDocumentAtPath(base, {
          path: SHARED_PATHS[i] as string,
          documentId,
          kind: 'spatial',
        })
      })
      // Pinned in the base, so that both directions of a pin write are a
      // change on a fork: an unpin removes an element, a pin of the third adds
      // one.
      for (const documentId of SHARED_IDS.slice(0, 2)) setWorkspacePinned(base, documentId, true)

      const replicaA = new LoroDoc()
      replicaA.setPeerId(2n)
      replicaA.import(base.export({ mode: 'snapshot' }))
      const replicaB = new LoroDoc()
      replicaB.setPeerId(3n)
      replicaB.import(base.export({ mode: 'snapshot' }))

      const effectsA = apply(replicaA, ownIds('A'), opsA)
      const effectsB = apply(replicaB, ownIds('B'), opsB)
      const reached = racesOf(effectsA, effectsB)
      races.cases += 1
      if (reached.any) races.any += 1
      if (reached.deleteVs) races.deleteVs += 1
      if (reached.deleteVsMove) races.deleteVsMove += 1
      if (reached.pinBoth) races.pinBoth += 1

      replicaA.import(replicaB.export({ mode: 'update' }))
      replicaB.import(replicaA.export({ mode: 'update' }))

      // The whole entry, shadowed marks included: a listing that agreed on
      // membership but not on who owns a contested path would still send two
      // clients to two different documents.
      expect(readWorkspaceDocuments(replicaA)).toEqual(readWorkspaceDocuments(replicaB))
      expect(readPinnedDocumentIds(replicaA)).toEqual(readPinnedDocumentIds(replicaB))
    },
    PROPERTY_TIMEOUT_MS,
  )

  afterAll(() => {
    // Skipped by a name filter: nothing ran, so there is nothing to measure.
    if (races.cases === 0) return
    expect(races.any / races.cases).toBeGreaterThanOrEqual(FLOORS.any)
    expect(races.deleteVs / races.cases).toBeGreaterThanOrEqual(FLOORS.deleteVs)
    expect(races.deleteVsMove / races.cases).toBeGreaterThanOrEqual(FLOORS.deleteVsMove)
    expect(races.pinBoth / races.cases).toBeGreaterThanOrEqual(FLOORS.pinBoth)
  })
})
