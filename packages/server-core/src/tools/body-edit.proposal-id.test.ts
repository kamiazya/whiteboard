import {
  readProposals,
  writeDocumentKind,
  writeMarkdownBody,
} from '@kamiazya/whiteboard-loro-adapter'
import { chunkSnapshot, reassembleSnapshot } from '@kamiazya/whiteboard-ports'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, test } from 'vitest'
import {
  FakeDocumentStore,
  registerDocumentInWorkspace,
} from '../test-utils/fake-document-store.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { createBodyEditTool } from './body-edit.js'

const DOCUMENT_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
const WORKSPACE_ID = 'ws-1'
const BODY = 'Ship on Thursday. Review on Friday.\n'
const docRef = { kind: 'document' as const, workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID }

async function seeded() {
  const store = new FakeDocumentStore()
  await registerDocumentInWorkspace(store, WORKSPACE_ID, DOCUMENT_ID)
  const doc = new LoroDoc()
  writeDocumentKind(doc, 'markdown')
  writeMarkdownBody(doc, BODY)
  const { manifest, chunks } = chunkSnapshot(doc.export({ mode: 'snapshot' }), 1_000_000)
  await store.saveSnapshot({
    docRef,
    manifest,
    chunks,
    frontier: doc.oplogVersion().encode() as Uint8Array<ArrayBuffer>,
  })
  const tool = createBodyEditTool(
    makeTestDeps({ documentStore: store, documentIndex: store.documentIndex }),
  )
  return { store, tool }
}

/** One passage proposed, optionally under a caller-chosen proposal id. */
function propose(
  tool: Awaited<ReturnType<typeof seeded>>['tool'],
  change: { id: string; exact: string; text: string },
  proposalId?: string,
) {
  const start = BODY.indexOf(change.exact)
  return tool.execute({
    workspaceId: WORKSPACE_ID,
    documentId: DOCUMENT_ID,
    ...(proposalId === undefined ? {} : { proposalId }),
    ops: [
      {
        id: change.id,
        op: 'body.replace',
        anchor: {
          kind: 'text',
          quote: { exact: change.exact },
          start,
          end: start + change.exact.length,
        },
        text: change.text,
        assumed: change.exact,
      },
    ],
  })
}

async function storedProposals(store: FakeDocumentStore) {
  const saved = await store.loadSnapshot({ docRef })
  if (saved === null) throw new Error('nothing saved')
  const doc = new LoroDoc()
  doc.import(reassembleSnapshot(saved.manifest, saved.chunks))
  return readProposals(doc)
}

describe('wb_body_edit proposal ids', () => {
  test('two proposing calls without a proposalId keep two proposals, the first still open', async () => {
    const { store, tool } = await seeded()

    const first = await propose(tool, { id: 'c1', exact: 'Thursday', text: 'Monday' })
    const second = await propose(tool, { id: 'c2', exact: 'Friday', text: 'Tuesday' })

    // A minted id that ignored the proposals already stored would overwrite
    // the first, and the agent's earlier proposal would vanish unannounced.
    expect(second.proposed?.id).not.toBe(first.proposed?.id)
    const proposals = await storedProposals(store)
    expect(proposals.map((p) => p.id).sort()).toEqual(
      [first.proposed?.id, second.proposed?.id].sort(),
    )
    expect(proposals.find((p) => p.id === first.proposed?.id)?.changes[0]).toMatchObject({
      id: 'c1',
      text: 'Monday',
    })
  })

  test('mints the first proposal id no stored proposal holds', async () => {
    const { store, tool } = await seeded()

    await propose(tool, { id: 'c1', exact: 'Thursday', text: 'Monday' }, 'p1')
    const minted = await propose(tool, { id: 'c2', exact: 'Friday', text: 'Tuesday' })

    expect(minted.proposed?.id).toBe('p2')
    expect((await storedProposals(store)).map((p) => p.id).sort()).toEqual(['p1', 'p2'])
  })
})
