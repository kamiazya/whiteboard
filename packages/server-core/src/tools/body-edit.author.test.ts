// Who proposed a passage is the caller's to say: server-core carries no
// operator identity, so an author reaches a proposal only through the tool's
// input, the way `wb_thread_edit` takes one for a message.

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

function passage(id: string, exact: string, text: string) {
  const start = BODY.indexOf(exact)
  return {
    id,
    op: 'body.replace' as const,
    anchor: { kind: 'text' as const, quote: { exact }, start, end: start + exact.length },
    text,
    assumed: exact,
  }
}

async function storedProposals(store: FakeDocumentStore) {
  const saved = await store.loadSnapshot({ docRef })
  if (saved === null) throw new Error('nothing saved')
  const doc = new LoroDoc()
  doc.import(reassembleSnapshot(saved.manifest, saved.chunks))
  return readProposals(doc)
}

describe('wb_body_edit proposal author', () => {
  test('records the author the caller names on the proposal it opens', async () => {
    const { store, tool } = await seeded()

    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      author: 'claude-code/1.0',
      ops: [passage('c1', 'Thursday', 'Monday')],
    })

    expect(result.proposed?.author).toBe('claude-code/1.0')
    expect((await storedProposals(store))[0]?.author).toBe('claude-code/1.0')
  })

  test('stores no author when the caller names none', async () => {
    const { tool } = await seeded()

    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      ops: [passage('c1', 'Thursday', 'Monday')],
    })

    expect(result.proposed).toBeDefined()
    expect(result.proposed).not.toHaveProperty('author')
  })

  test('a call continuing a proposal keeps the author who opened it', async () => {
    const { tool } = await seeded()

    const first = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      author: 'claude-code/1.0',
      ops: [passage('c1', 'Thursday', 'Monday')],
    })
    const second = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      proposalId: first.proposed?.id ?? '',
      author: 'someone-else/2.0',
      ops: [passage('c2', 'Friday', 'Tuesday')],
    })

    expect(second.proposed?.changes).toHaveLength(2)
    expect(second.proposed?.author).toBe('claude-code/1.0')
  })

  test('refuses an author that is not a single-line actor', async () => {
    const { tool } = await seeded()
    const parsed = tool.inputSchema.safeParse({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      author: '',
      ops: [passage('c1', 'Thursday', 'Monday')],
    })

    expect(parsed.success).toBe(false)
  })
})
