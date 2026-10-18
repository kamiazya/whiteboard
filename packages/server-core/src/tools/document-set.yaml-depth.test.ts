// A frontmatter nested past the bound is refused before anything is stored:
// serialising it is about the square of its depth, paid on every read.

import { readFacets, readMarkdownBody } from '@kamiazya/whiteboard-loro-adapter'
import { reassembleSnapshot } from '@kamiazya/whiteboard-ports'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import {
  FakeDocumentStore,
  registerDocumentInWorkspace,
} from '../test-utils/fake-document-store.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { createDocumentSetOperation, OkfParseError } from './document-set.js'

const WORKSPACE_ID = 'ws-depth'
const DOCUMENT_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'

describe('a frontmatter nested past 32 levels', () => {
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
      markdown: `---\ntype: note\ndeep: ${'{a: '.repeat(500)}1${'}'.repeat(500)}\n---\ndeep body`,
    })
    await expect(attempt).rejects.toBeInstanceOf(OkfParseError)
    await expect(attempt).rejects.toMatchObject({ stage: 'yaml' })
    await expect(attempt).rejects.toThrow(/at most 32 levels/)

    const snap = await store.loadSnapshot({
      docRef: { kind: 'document', workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID },
    })
    if (!snap) throw new Error('no snapshot')
    const doc = new LoroDoc()
    doc.import(reassembleSnapshot(snap.manifest, snap.chunks))
    expect(readMarkdownBody(doc)).toBe('original body')
    expect(JSON.stringify(readFacets(doc) ?? {})).not.toContain('deep')
  })
})
