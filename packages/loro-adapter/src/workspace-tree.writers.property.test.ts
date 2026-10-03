/**
 * Completeness of the workspace listing under every writer.
 *
 * `readWorkspaceDocuments` skips a node its schema rejects, and a skipped node
 * takes its whole subtree with it — so a writer that stores a value the reader
 * refuses makes a document vanish without an error. The invariant is that no
 * sequence of writes, whatever strings the names carry, loses a live document.
 * A writer that REFUSES an input (throws) is conforming; one that stores it and
 * hides the document is not.
 */
import { LoroDoc } from 'loro-crdt'
import { describe, expect } from 'vitest'
import { fc, fcTest, withDefaults } from './test-utils/fast-check.js'
import {
  createWorkspaceDocument,
  deleteWorkspaceDocument,
  moveWorkspaceDocument,
  readWorkspaceDocuments,
  setWorkspaceDocumentName,
  unreadableWorkspaceNodes,
  updateWorkspaceDocumentMeta,
} from './workspace-tree.js'

const IDS = Array.from({ length: 6 }, (_, i) => `01ARZ3NDEKTSV4RRFFQ69G5FZ${i}`)

const idArb = fc.nat({ max: IDS.length - 1 })
// Blank and padded names are the boundary the schema's min(1) draws.
const nameArb = fc.oneof(
  fc.constantFrom('', ' ', '\t', ' \n ', ' padded ', 'x'),
  fc.string({ unit: 'binary' }),
  fc.string(),
)
const opArb = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({
      op: fc.constant('create' as const),
      id: idArb,
      parent: fc.option(idArb, { nil: undefined }),
      name: fc.option(nameArb, { nil: undefined }),
    }),
  },
  {
    weight: 4,
    arbitrary: fc.record({
      op: fc.constant('rename' as const),
      id: idArb,
      name: fc.option(nameArb, { nil: undefined }),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      op: fc.constant('move' as const),
      id: idArb,
      parent: fc.option(idArb, { nil: undefined }),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      op: fc.constant('stamp' as const),
      id: idArb,
      at: fc.integer({ min: 0, max: 1000 }),
    }),
  },
  { weight: 1, arbitrary: fc.record({ op: fc.constant('delete' as const), id: idArb }) },
)

/** Where each live document sits, kept apart from the tree so the oracle never reads it. */
type Parents = Map<string, string | undefined>

function descendantsOf(parents: Parents, id: string): Set<string> {
  const out = new Set<string>([id])
  for (let grew = true; grew; ) {
    grew = false
    for (const [child, parent] of parents) {
      if (parent !== undefined && out.has(parent) && !out.has(child)) {
        out.add(child)
        grew = true
      }
    }
  }
  return out
}

function attempt(write: () => void): boolean {
  try {
    write()
    return true
  } catch {
    return false
  }
}

function apply(
  doc: LoroDoc,
  parents: Parents,
  op: typeof opArb extends fc.Arbitrary<infer T> ? T : never,
): void {
  const id = IDS[op.id] as string
  // A parent that is not live would make the write throw, and a property in which
  // most creates throw never reaches the arrangements it exists for.
  const wanted = 'parent' in op && op.parent !== undefined ? (IDS[op.parent] as string) : undefined
  const parent = wanted !== undefined && parents.has(wanted) ? wanted : undefined
  if (op.op === 'create') {
    if (parents.has(id)) return
    if (
      attempt(() =>
        createWorkspaceDocument(doc, {
          documentId: id,
          segment: `s${op.id}`,
          kind: 'markdown',
          parentId: parent,
          ...(op.name === undefined ? {} : { name: op.name }),
        }),
      )
    ) {
      parents.set(id, parent)
    }
  } else if (!parents.has(id)) {
    return
  } else if (op.op === 'rename') {
    attempt(() => setWorkspaceDocumentName(doc, { documentId: id, name: op.name }))
  } else if (op.op === 'move') {
    if (attempt(() => moveWorkspaceDocument(doc, { documentId: id, parentId: parent }))) {
      parents.set(id, parent)
    }
  } else if (op.op === 'stamp') {
    attempt(() => updateWorkspaceDocumentMeta(doc, id, { updatedAt: op.at }))
  } else {
    deleteWorkspaceDocument(doc, { documentId: id })
    for (const gone of descendantsOf(parents, id)) parents.delete(gone)
  }
}

describe('workspace-tree writers keep the listing complete', () => {
  fcTest.prop([fc.array(opArb, { minLength: 1, maxLength: 40 })], withDefaults())(
    'every live document stays listed, and no write leaves an unreadable node',
    (ops) => {
      const doc = new LoroDoc()
      const parents: Parents = new Map()
      for (const op of ops) {
        apply(doc, parents, op)
        expect(
          readWorkspaceDocuments(doc)
            .map((d) => d.documentId)
            .sort(),
        ).toEqual([...parents.keys()].sort())
        expect(unreadableWorkspaceNodes(doc)).toEqual([])
      }
    },
  )
})
