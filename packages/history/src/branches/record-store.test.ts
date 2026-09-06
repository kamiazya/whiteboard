/**
 * Branches as a plane of the workspace record, which is what lets both
 * keepers hold them.
 *
 * The daemon keeps a branch as a SQLite row and the browser has no SQLite,
 * so the row is the reason the browser has no variations at all. A branch is
 * a name and a frontier OF THE RECORD — the record already travels between
 * every replica, so putting the branch beside the document it belongs to
 * costs no second transport and gives the browser the same feature for free.
 *
 * The case that decides the storage shape is `converges`: two replicas that
 * have never seen each other's branch must end up holding BOTH. A plain
 * value at the key cannot do that, and its failure is the silent kind —
 * both sides agree on the survivor and nothing is red.
 */
import {
  createWorkspaceDocument,
  resolveWorkspaceDocumentById,
} from '@kamiazya/whiteboard-loro-adapter'
import { generateDocumentId } from '@kamiazya/whiteboard-model'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { readBranchesFromRecord, writeBranchesToRecord } from './record-store.js'
import { defaultMain } from './schema.js'

const AT = '2026-01-02T03:04:05.000Z'

function recordWithDocument(): { doc: LoroDoc; documentId: string } {
  const doc = new LoroDoc()
  const documentId = generateDocumentId()
  createWorkspaceDocument(doc, { documentId, segment: 'untitled', kind: 'spatial' })
  return { doc, documentId }
}

function branch(
  name: string,
  over: Partial<{ tipFrontiers: string; color: string; createdAt: string }> = {},
) {
  return { name, tipFrontiers: '', color: '#9333ea', createdAt: AT, ...over }
}

describe('branches on the workspace record', () => {
  it('reads a document that has never had a branch as main alone', () => {
    const { doc, documentId } = recordWithDocument()

    const state = readBranchesFromRecord(doc, documentId, new Date(AT))

    expect(state).toEqual({ branches: [defaultMain(new Date(AT))], head: 'main' })
  })

  it('reads back what was written, oldest first and ties broken by name', () => {
    const { doc, documentId } = recordWithDocument()
    const later = '2026-02-02T03:04:05.000Z'

    writeBranchesToRecord(doc, documentId, {
      branches: [
        branch('zeta', { createdAt: AT }),
        branch('draft', { createdAt: later, tipFrontiers: 'AQID' }),
        branch('alpha', { createdAt: AT }),
      ],
      head: 'draft',
    })

    const state = readBranchesFromRecord(doc, documentId, new Date(AT))
    expect(state.branches.map((b) => b.name)).toEqual(['alpha', 'zeta', 'draft'])
    expect(state.branches.find((b) => b.name === 'draft')?.tipFrontiers).toBe('AQID')
    expect(state.head).toBe('draft')
  })

  it('keeps the optional lineage fields a branch was created with', () => {
    const { doc, documentId } = recordWithDocument()

    writeBranchesToRecord(doc, documentId, {
      branches: [{ ...branch('draft'), baseBranch: 'main', baseVersionId: '01J0' }],
      head: 'main',
    })

    expect(readBranchesFromRecord(doc, documentId, new Date(AT)).branches[0]).toEqual({
      ...branch('draft'),
      baseBranch: 'main',
      baseVersionId: '01J0',
    })
  })

  it('drops a branch the next written state no longer holds', () => {
    const { doc, documentId } = recordWithDocument()
    writeBranchesToRecord(doc, documentId, {
      branches: [branch('main'), branch('draft')],
      head: 'main',
    })

    writeBranchesToRecord(doc, documentId, { branches: [branch('main')], head: 'main' })

    expect(
      readBranchesFromRecord(doc, documentId, new Date(AT)).branches.map((b) => b.name),
    ).toEqual(['main'])
  })

  it('answers main for a HEAD pointer naming a branch that is gone', () => {
    const { doc, documentId } = recordWithDocument()
    writeBranchesToRecord(doc, documentId, {
      branches: [branch('main'), branch('draft')],
      head: 'draft',
    })

    writeBranchesToRecord(doc, documentId, { branches: [branch('main')], head: 'main' })

    expect(readBranchesFromRecord(doc, documentId, new Date(AT)).head).toBe('main')
  })

  it('writes HEAD where the record already keeps it, so nothing reads two pointers', () => {
    const { doc, documentId } = recordWithDocument()

    writeBranchesToRecord(doc, documentId, {
      branches: [branch('main'), branch('draft')],
      head: 'draft',
    })

    expect(resolveWorkspaceDocumentById(doc, documentId)?.currentBranch).toBe('draft')
  })

  it('answers false for a document the record does not hold, and reads it as main', () => {
    const { doc } = recordWithDocument()
    const absent = generateDocumentId()

    expect(writeBranchesToRecord(doc, absent, { branches: [branch('draft')], head: 'draft' })).toBe(
      false,
    )
    expect(readBranchesFromRecord(doc, absent, new Date(AT)).branches.map((b) => b.name)).toEqual([
      'main',
    ])
  })

  it('converges on BOTH branches when two replicas each make one the other never saw', () => {
    // The common ancestor holds the document and no branch plane at all, so
    // each replica is the first to open it — the exact state in which a
    // regular child container hides one of the two.
    const { doc, documentId } = recordWithDocument()
    const a = new LoroDoc()
    a.import(doc.export({ mode: 'snapshot' }))
    const b = new LoroDoc()
    b.import(doc.export({ mode: 'snapshot' }))

    writeBranchesToRecord(a, documentId, {
      branches: [branch('main'), branch('from-a')],
      head: 'main',
    })
    writeBranchesToRecord(b, documentId, {
      branches: [branch('main'), branch('from-b')],
      head: 'main',
    })
    a.import(b.export({ mode: 'snapshot' }))
    b.import(a.export({ mode: 'snapshot' }))

    for (const replica of [a, b]) {
      expect(
        readBranchesFromRecord(replica, documentId, new Date(AT)).branches.map((x) => x.name),
      ).toEqual(['from-a', 'from-b', 'main'])
    }
  })
})
