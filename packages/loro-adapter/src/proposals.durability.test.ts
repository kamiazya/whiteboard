// The proposals plane is the same shape as the threads plane — a mergeable
// container per proposal under `proposals` — and went through the same
// flattening fold. See comment-threads.durability.test.ts.
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { readProposals, writeProposal } from './proposals.js'
import {
  createWorkspaceDocument,
  projectWorkspaceDocument,
  writeWorkspaceDocumentContent,
} from './workspace-tree.js'

const ID = '01HZZZZZZZZZZZZZZZZZZZZZZ2'

describe('a proposal survives the workspace record', () => {
  it('fold into the record, reopen, project: the proposal is still a proposal', () => {
    const record = new LoroDoc()
    record.setPeerId(1n)
    createWorkspaceDocument(record, { documentId: ID, segment: 'board', kind: 'spatial' })
    const live = projectWorkspaceDocument(record, ID)
    if (live === null) throw new Error('no projection')
    const before = readProposals(live)
    writeProposal(live, {
      id: 'p1',
      createdAt: '2026-09-02T00:00:00.000Z',
      changes: [
        {
          id: 'c1',
          op: 'node.add',
          status: 'open',
          node: { id: 'n1', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'hi' },
        },
      ],
    })
    const written = readProposals(live)
    expect(written.length).toBe(before.length + 1)
    writeWorkspaceDocumentContent(record, ID, live)

    const reopened = LoroDoc.fromSnapshot(record.export({ mode: 'snapshot' }))
    const projected = projectWorkspaceDocument(reopened, ID)
    if (projected === null) throw new Error('no projection')
    expect(readProposals(projected)).toEqual(written)
  })
})
