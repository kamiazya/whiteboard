// Who proposed a batch is the caller's to say: server-core carries no operator
// identity, so an author reaches a proposal only through the tool's input,
// the way `wb_thread_edit` takes one for a message.

import {
  readProposals,
  writeDocumentKind,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, test } from 'vitest'
import { loadDocument } from '../document-io.js'
import {
  FakeDocumentStore,
  registerDocumentInWorkspace,
  seedDoc,
} from '../test-utils/fake-document-store.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { createCanvasEditTool } from './canvas-edit.js'

const DOCUMENT_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
const WORKSPACE_ID = 'ws-1'

const BOARD: SpatialCanvas = {
  nodes: [
    textNode({ id: 'a', x: 0, y: 0, width: 100, height: 40, text: 'A' }),
    textNode({ id: 'b', x: 200, y: 0, width: 100, height: 40, text: 'B' }),
  ],
  edges: [],
}

async function seeded() {
  const store = new FakeDocumentStore()
  await seedDoc(store, DOCUMENT_ID, (doc) => {
    writeDocumentKind(doc, 'spatial')
    writeSpatialCanvas(doc, BOARD)
  })
  await registerDocumentInWorkspace(store, WORKSPACE_ID, DOCUMENT_ID)
  const deps = makeTestDeps({ documentStore: store, documentIndex: store.documentIndex })
  return { deps, tool: createCanvasEditTool(deps) }
}

describe('wb_canvas_edit proposal author', () => {
  test('records the author the caller names on the proposal it opens', async () => {
    const { deps, tool } = await seeded()

    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'propose',
      author: 'claude-code/1.0',
      ops: [{ op: 'node.patch', id: 'a', patch: { x: 400 } }],
    })

    expect(result.proposed?.author).toBe('claude-code/1.0')
    const { doc } = await loadDocument(deps, WORKSPACE_ID, DOCUMENT_ID)
    expect(readProposals(doc)[0]?.author).toBe('claude-code/1.0')
  })

  test('stores no author when the caller names none', async () => {
    const { tool } = await seeded()

    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'propose',
      ops: [{ op: 'node.patch', id: 'a', patch: { x: 400 } }],
    })

    expect(result.proposed).toBeDefined()
    expect(result.proposed).not.toHaveProperty('author')
  })

  test('a call continuing a proposal keeps the author who opened it', async () => {
    const { tool } = await seeded()

    const first = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'propose',
      author: 'claude-code/1.0',
      ops: [{ op: 'node.patch', id: 'a', patch: { x: 400 } }],
    })
    const second = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'propose',
      proposalId: first.proposed?.id,
      author: 'someone-else/2.0',
      ops: [{ op: 'node.patch', id: 'b', patch: { y: 300 } }],
    })

    expect(second.proposed?.changes).toHaveLength(2)
    expect(second.proposed?.author).toBe('claude-code/1.0')
  })

  test('refuses an author that is not a single-line actor', async () => {
    const { tool } = await seeded()
    const parsed = tool.inputSchema.safeParse({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'propose',
      author: ' padded\n',
      ops: [{ op: 'node.patch', id: 'a', patch: { x: 400 } }],
    })

    expect(parsed.success).toBe(false)
  })
})
