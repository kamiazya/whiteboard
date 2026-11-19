/**
 * A move's collision check must cost one pass over the record's nodes, not
 * one per folder: a record may hold 4000 folders beside 2000 documents, and a
 * pairwise check is 24 million prefix tests on every move, paid before the
 * move is refused or made.
 *
 * Counted rather than timed — every prefix test is a call of the model's
 * `isSelfOrDescendant`.
 */
import { generateDocumentId } from '@kamiazya/whiteboard-model'
import { describe, expect, it, vi } from 'vitest'
import {
  INDEX_SUBJECTS,
  indexOver,
  inMemoryBlobStore,
  liveWorkspaceDocs,
} from './test-utils/index-subjects.js'

// `vi.mock` is hoisted above the imports, so the index calls the wrapped
// prefix test and the calls it makes are the ones this file counts.
const counted = vi.hoisted(() => ({ calls: 0 }))
vi.mock('@kamiazya/whiteboard-model', async (original) => {
  const actual = await original<typeof import('@kamiazya/whiteboard-model')>()
  return {
    ...actual,
    isSelfOrDescendant: (path: string, ancestor: string) => {
      counted.calls += 1
      return actual.isSelfOrDescendant(path, ancestor)
    },
  }
})

const WS = '01JDZNGS07Y9E7Q7XVJ69S28B9'
const FOLDERS = 2000
const DOCUMENTS = 500

describe.each(INDEX_SUBJECTS)('a move in a record holding many folders over $name', (subject) => {
  it('tests each node against a prefix a bounded number of times', async () => {
    const docs = liveWorkspaceDocs(subject)
    const index = indexOver(subject, docs, inMemoryBlobStore())
    await index.createWorkspace({ workspaceId: WS })
    // Placed in one batch: the move is the subject, and a create through the
    // index reads the whole record each time.
    subject.kind.write(
      docs.peek(WS),
      Array.from({ length: DOCUMENTS }, (_, i) => ({
        op: 'createWorkspaceDocumentAtPath' as const,
        args: { path: `docs/d${i}`, documentId: generateDocumentId(), kind: 'markdown' as const },
      })),
    )
    await subject.fillFolders(docs.peek(WS), FOLDERS)
    const nodes = FOLDERS + DOCUMENTS + 1

    counted.calls = 0
    await index.moveDocument({ workspaceId: WS, from: 'docs/d0', to: 'moved' })

    // The subject is present: the move does test prefixes.
    expect(counted.calls).toBeGreaterThan(0)
    expect(counted.calls).toBeLessThanOrEqual(4 * nodes)
  }, 120_000)
})
