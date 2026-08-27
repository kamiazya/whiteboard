/**
 * Concurrent-replica convergence of the workspace record's LISTING
 * (dual-plane collapse S5a).
 *
 * The read flip (S5b) makes `readWorkspaceDocuments` the source every
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
 */
import { LoroDoc } from 'loro-crdt'
import { describe, expect } from 'vitest'
import { fc, fcTest, withDefaults } from './test-utils/fast-check.js'
import {
  createWorkspaceDocumentAtPath,
  deleteWorkspaceDocument,
  moveWorkspaceNodeToPath,
  readPinnedDocumentIds,
  readWorkspaceDocuments,
  resolveWorkspaceDocumentById,
  setWorkspacePinned,
  updateWorkspaceDocumentMeta,
} from './workspace-tree.js'

const PATHS = ['a', 'b', 'c', 'a/x', 'a/y', 'b/x'] as const

// Crockford-valid ULIDs, one pool per replica so concurrent creates carry
// distinct ids the way two real peers' creates would.
function idPool(marker: 'A' | 'B'): string[] {
  return Array.from({ length: 6 }, (_, i) => `01ARZ3NDEKTSV4RRFFQ69G5F${marker}${i}`)
}

const pathArb = fc.constantFrom(...PATHS)
const opArb = fc.oneof(
  fc.record({ op: fc.constant('create' as const), path: pathArb, idIndex: fc.nat({ max: 5 }) }),
  fc.record({ op: fc.constant('move' as const), from: pathArb, to: pathArb }),
  fc.record({ op: fc.constant('delete' as const), idIndex: fc.nat({ max: 5 }) }),
  fc.record({ op: fc.constant('pin' as const), idIndex: fc.nat({ max: 5 }), pinned: fc.boolean() }),
  fc.record({
    op: fc.constant('head' as const),
    idIndex: fc.nat({ max: 5 }),
    branch: fc.constantFrom('main', 'feature'),
  }),
)
type Op = typeof opArb extends fc.Arbitrary<infer T> ? T : never

function apply(doc: LoroDoc, ownIds: string[], ops: Op[]): void {
  for (const op of ops) {
    switch (op.op) {
      case 'create':
        // Null (a document already owns the path) is a fine local refusal;
        // the interesting collisions are the CONCURRENT ones neither
        // replica could see coming.
        createWorkspaceDocumentAtPath(doc, {
          path: op.path,
          documentId: ownIds[op.idIndex] as string,
          kind: 'spatial',
        })
        break
      case 'move':
        // moveWorkspaceNodeToPath documents that the CALLER pre-checks (the
        // port's index guards with isSelfOrDescendant before calling); a
        // locally-illegal self/descendant move throws in Loro and is not a
        // convergence question. Concurrent moves that only become cyclic
        // after the merge stay in — resolving those IS the tree's job.
        if (op.to !== op.from && !op.to.startsWith(`${op.from}/`)) {
          moveWorkspaceNodeToPath(doc, op.from, op.to)
        }
        break
      case 'delete':
        deleteWorkspaceDocument(doc, { documentId: ownIds[op.idIndex] as string })
        break
      case 'pin': {
        const documentId = ownIds[op.idIndex] as string
        if (resolveWorkspaceDocumentById(doc, documentId) !== null) {
          setWorkspacePinned(doc, documentId, op.pinned)
        }
        break
      }
      case 'head': {
        const documentId = ownIds[op.idIndex] as string
        if (resolveWorkspaceDocumentById(doc, documentId) !== null) {
          updateWorkspaceDocumentMeta(doc, documentId, { currentBranch: op.branch })
        }
        break
      }
    }
  }
}

describe('workspace-record listing convergence (S5a)', () => {
  fcTest.prop(
    [fc.array(opArb, { maxLength: 8 }), fc.array(opArb, { maxLength: 8 })],
    withDefaults(),
  )('two replicas converge on one listing, pin list, and meta', (opsA: Op[], opsB: Op[]) => {
    const base = new LoroDoc()
    base.setPeerId(1n)
    createWorkspaceDocumentAtPath(base, {
      path: 'a',
      documentId: '01ARZ3NDEKTSV4RRFFQ69G5FZ0',
      kind: 'spatial',
    })

    const replicaA = new LoroDoc()
    replicaA.setPeerId(2n)
    replicaA.import(base.export({ mode: 'snapshot' }))
    const replicaB = new LoroDoc()
    replicaB.setPeerId(3n)
    replicaB.import(base.export({ mode: 'snapshot' }))

    apply(replicaA, idPool('A'), opsA)
    apply(replicaB, idPool('B'), opsB)

    replicaA.import(replicaB.export({ mode: 'update' }))
    replicaB.import(replicaA.export({ mode: 'update' }))

    // The whole entry, shadowed marks included: a listing that agreed on
    // membership but not on who owns a contested path would still send two
    // clients to two different documents.
    expect(readWorkspaceDocuments(replicaA)).toEqual(readWorkspaceDocuments(replicaB))
    expect(readPinnedDocumentIds(replicaA)).toEqual(readPinnedDocumentIds(replicaB))
  })
})
