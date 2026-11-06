import 'fake-indexeddb/auto'
import { writeMarkdownBody } from '@kamiazya/whiteboard-loro-adapter'
import { Loro } from 'loro-crdt'
import { beforeEach, describe, expect, it } from 'vitest'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { seedWorkspaceDocumentContent } from '../test-utils/seed-workspace-content.js'
import { BrowserDocumentIndex } from './browser-document-index.js'
import { ensureBrowserWorkspace } from './browser-document-summary.js'
import { createBrowserFilesSource } from './browser-files-source.js'
import { getBrowserWorkspaceId } from './browser-workspace-id.js'

claimIsolatedWhiteboardDb('browser-files-source-search-names')

// The daemon's half is server-core's document-search.folder-names.test.ts
// and document-search.link-labels.test.ts: both keepers hand
// `packages/search` the folder names and the link labels, and this holds the
// browser's.
describe('createBrowserFilesSource search by display names', () => {
  beforeEach(clearWhiteboardDb)

  it('finds a document by its folder’s display name, below one that says the word', async () => {
    const index = new BrowserDocumentIndex()
    await ensureBrowserWorkspace(index)
    const source = createBrowserFilesSource({ index })
    await source.createDocument('quipe-ops/untitled-8', 'markdown')
    await source.createDocument('reports/review', 'markdown', 'Operations review')
    await source.createDocument('misc/other', 'markdown')
    await source.setFolderName?.('quipe-ops', 'Operations Team')

    const hits = await source.searchDocuments('operations')
    expect(hits.map((hit) => hit.document.path)).toEqual(['reports/review', 'quipe-ops/untitled-8'])
  })

  it('quotes a [[link]] in an excerpt by the name of what it points at', async () => {
    const index = new BrowserDocumentIndex()
    await ensureBrowserWorkspace(index)
    const source = createBrowserFilesSource({ index })
    await source.createDocument('folder/deep-learning/transformer', 'markdown', 'Transformer')
    const entry = await index.createDocument({
      workspaceId: getBrowserWorkspaceId(),
      path: 'folder/gaiyo',
      kind: 'markdown',
    })
    const doc = new Loro()
    writeMarkdownBody(doc, '注意機構は [[folder/deep-learning/transformer]] の核')
    await seedWorkspaceDocumentContent(entry.documentId, doc.export({ mode: 'snapshot' }))

    const [hit] = await source.searchDocuments('注意機構')
    expect(hit?.contexts).toEqual(['注意機構は Transformer の核'])
  })
})
