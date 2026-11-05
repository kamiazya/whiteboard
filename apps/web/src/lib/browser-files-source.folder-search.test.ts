import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { ensureBrowserWorkspace } from './browser-document-summary.js'
import { createBrowserFilesSource } from './browser-files-source.js'
import { FoldingBrowserIndex } from './folding-browser-index.js'

claimIsolatedWhiteboardDb('browser-files-source-folder-search')

// The daemon's half is server-core's document-search.folder-names.test.ts:
// both keepers hand `packages/search` the folder names, and this holds the
// browser's.
describe('createBrowserFilesSource search over folder names', () => {
  beforeEach(clearWhiteboardDb)

  it('finds a document by its folder’s display name, below one that says the word', async () => {
    const index = new FoldingBrowserIndex()
    await ensureBrowserWorkspace(index)
    const source = createBrowserFilesSource({ index })
    await source.createDocument('quipe-ops/untitled-8', 'markdown')
    await source.createDocument('reports/review', 'markdown', 'Operations review')
    await source.createDocument('misc/other', 'markdown')
    await source.setFolderName?.('quipe-ops', 'Operations Team')

    const hits = await source.searchDocuments('operations')
    expect(hits.map((hit) => hit.document.path)).toEqual(['reports/review', 'quipe-ops/untitled-8'])
  })
})
