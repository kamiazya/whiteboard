// An alias resolves to the same value as its anchor, so a short frontmatter
// can name one large list many times over; every write path refuses it before
// anything is stored.

import { readFacets, readMarkdownBody } from '@kamiazya/whiteboard-loro-adapter'
import { reassembleSnapshot } from '@kamiazya/whiteboard-ports'
import { InMemoryDocumentStore } from '@kamiazya/whiteboard-ports/test-utils'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { apiErrorReason } from '../api-errors.js'
import { createServer } from '../create-server.js'
import {
  FakeDocumentStore,
  registerDocumentInWorkspace,
} from '../test-utils/fake-document-store.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { inMemoryDocumentTeardown } from '../test-utils/unused-document-teardown.js'
import { wbDocumentCreate } from './document-crud.js'
import { createDocumentSetOperation, OkfParseError } from './document-set.js'

const WORKSPACE_ID = 'ws-alias'
const DOCUMENT_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
const ALIASED = [
  '---',
  'type: note',
  `leaf: &a [${Array.from({ length: 2000 }, (_, i) => i).join(', ')}]`,
  `x: [${Array.from({ length: 99 }, () => '*a').join(', ')}]`,
  '---',
  'aliased body',
].join('\n')

describe('a frontmatter carrying YAML aliases', () => {
  it('is refused by document.set at stage yaml, leaving the stored document as it was', async () => {
    const store = new FakeDocumentStore()
    await registerDocumentInWorkspace(store, WORKSPACE_ID, DOCUMENT_ID)
    const deps = makeTestDeps({ documentStore: store, documentIndex: store.documentIndex })
    const tool = createDocumentSetOperation(deps)
    await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      markdown: '---\ntype: note\nkept: 1\n---\noriginal body',
    })

    const attempt = tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      markdown: ALIASED,
    })
    await expect(attempt).rejects.toBeInstanceOf(OkfParseError)
    await expect(attempt).rejects.toMatchObject({ stage: 'yaml' })

    const snap = await store.loadSnapshot({
      docRef: { kind: 'document', workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID },
    })
    if (!snap) throw new Error('no snapshot')
    const doc = new LoroDoc()
    doc.import(reassembleSnapshot(snap.manifest, snap.chunks))
    expect(readMarkdownBody(doc)).toBe('original body')
    expect(JSON.stringify(readFacets(doc) ?? {})).not.toContain('leaf')
  })

  it('is refused by wb_document_create before the document exists', async () => {
    const deps = makeTestDeps()
    await deps.documentIndex.createWorkspace({ workspaceId: WORKSPACE_ID })
    await expect(
      wbDocumentCreate(deps, {
        workspaceId: WORKSPACE_ID,
        path: 'x',
        kind: 'markdown',
        markdown: ALIASED,
      }),
    ).rejects.toThrow(/alias/i)
    expect(await deps.documentIndex.listDocuments({ workspaceId: WORKSPACE_ID })).toEqual([])
  })

  it('is refused by POST /api/v1 documents as a parse refusal', async () => {
    const deps = makeTestDeps({
      documentStore: new InMemoryDocumentStore(),
      documentTeardown: inMemoryDocumentTeardown(),
    })
    await deps.documentIndex.createWorkspace({ workspaceId: WORKSPACE_ID })
    const { app } = createServer(deps)
    const res = await app.request(`/api/v1/workspaces/${WORKSPACE_ID}/documents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'x', kind: 'markdown', markdown: ALIASED }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body).toMatchObject({ error: 'okf_parse_failed' })
    expect(apiErrorReason(body)).toMatch(/alias/i)
  })
})
