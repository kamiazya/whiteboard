/**
 * A read that names a document by its path, or reads its content by its id,
 * answers what a walk of the tree finds, however the record has been edited
 * between the reads: documents created, moved under another path, deleted,
 * with and without a commit in between. The reads may find the node without a
 * walk (a lookup kept for the state the record is at); the walk is what they
 * must agree with, so each step asks both.
 */
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { writeMarkdownBody } from '../markdown-body.js'
import { countSpatialNodes } from '../spatial-node-count.js'
import { fc, withDefaults } from '../test-utils/fast-check.js'
import {
  createWorkspaceDocumentAtPath,
  deleteWorkspaceNodeAtPath,
  documentContainers,
  moveWorkspaceNodeToPath,
  resolveWorkspaceDocument,
} from '../workspace-tree.js'
import { readQuery } from './readers.js'

const PATHS = ['a', 'b', 'a/x', 'b/x'] as const
const path = fc.constantFrom(...PATHS)

type Step =
  | { op: 'create'; path: (typeof PATHS)[number]; kind: 'markdown' | 'spatial' }
  | { op: 'move'; from: (typeof PATHS)[number]; to: (typeof PATHS)[number] }
  | { op: 'delete'; path: (typeof PATHS)[number] }
  | { op: 'edit'; path: (typeof PATHS)[number]; text: string }
  | { op: 'commit' }

const step: fc.Arbitrary<Step> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({
      op: fc.constant('create' as const),
      path,
      kind: fc.constantFrom('markdown' as const, 'spatial' as const),
    }),
  },
  { weight: 4, arbitrary: fc.record({ op: fc.constant('move' as const), from: path, to: path }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constant('delete' as const), path }) },
  {
    weight: 2,
    arbitrary: fc.record({
      op: fc.constant('edit' as const),
      path,
      text: fc.string({ maxLength: 8 }),
    }),
  },
  { weight: 2, arbitrary: fc.constant({ op: 'commit' as const }) },
)

function idOf(n: number): string {
  return `01BRWAAAAAAAAAAAAAAAAAA${String(n).padStart(3, '0')}`
}

/** Runs a step, ignoring the refusals a random sequence is bound to meet (a path with no parent, one already taken). */
function apply(doc: LoroDoc, next: Step, minted: { count: number }): void {
  try {
    if (next.op === 'create') {
      createWorkspaceDocumentAtPath(doc, {
        path: next.path,
        documentId: idOf(minted.count++),
        kind: next.kind,
      })
    } else if (next.op === 'move') {
      if (moveWorkspaceNodeToPath(doc, next.from, next.to)) reached.movesLanded++
    } else if (next.op === 'delete') {
      deleteWorkspaceNodeAtPath(doc, next.path)
    } else if (next.op === 'edit') {
      const entry = resolveWorkspaceDocument(doc, next.path)
      if (entry?.kind === 'markdown') {
        writeMarkdownBody(documentContainers(doc, entry.documentId), next.text)
      }
    } else {
      doc.commit()
    }
  } catch {
    // refused: the record is what it was
  }
}

const refusedOrValue = async (read: () => Promise<unknown>): Promise<unknown> =>
  read().then(
    (value) => ({ value }),
    () => ({ refused: true }),
  )

/** What the generator reached: a property over a space it never entered asserts nothing. */
const reached = { entriesFound: 0, countsRead: 0, movesLanded: 0 }

async function expectReadsAgreeWithAWalk(doc: LoroDoc, ids: number): Promise<void> {
  for (const where of PATHS) {
    const walked = resolveWorkspaceDocument(doc, where) ?? null
    if (walked !== null) reached.entriesFound++
    const read = await readQuery(doc, { query: 'workspaceDocumentEntry', args: { path: where } })
    expect(read, `entry at ${where}`).toEqual({ ok: walked === null ? null : expect.anything() })
    if (walked !== null && 'ok' in read) {
      expect((read.ok as { documentId: string }).documentId).toBe(walked.documentId)
      expect((read.ok as { path: string }).path).toBe(walked.path)
      expect((read.ok as { contentDigest: string }).contentDigest).toBe(walked.contentDigest)
    }
  }
  for (let n = 0; n < ids; n++) {
    const id = idOf(n)
    const walked = await refusedOrValue(async () => countSpatialNodes(documentContainers(doc, id)))
    const read = await readQuery(doc, { query: 'spatialNodeCount', args: { documentId: id } })
    if ('ok' in read) reached.countsRead++
    expect('ok' in read ? { value: read.ok } : { refused: true }, `node count of ${id}`).toEqual(
      walked,
    )
  }
}

describe('reads that find a document by a lookup', () => {
  it('agree with a walk of the tree after every edit, committed or not', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(step, { maxLength: 24 }), async (steps) => {
        const doc = new LoroDoc()
        doc.setPeerId(2n)
        const minted = { count: 0 }
        for (const next of steps) {
          apply(doc, next, minted)
          await expectReadsAgreeWithAWalk(doc, minted.count)
        }
      }),
      withDefaults(),
    )
    // The sequences got to documents that exist, were moved, and were counted.
    expect(reached.entriesFound).toBeGreaterThan(200)
    expect(reached.countsRead).toBeGreaterThan(200)
    expect(reached.movesLanded).toBeGreaterThan(20)
  })
})
