import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { createBrowserFilesSource } from './browser-files-source.js'

claimIsolatedWhiteboardDb('browser-files-source-move-name')

describe('createBrowserFilesSource moves', () => {
  beforeEach(clearWhiteboardDb)

  it('refuses a move onto a name a sibling in the target folder shows, moving nothing', async () => {
    const source = createBrowserFilesSource()
    await source.createDocument('week/plan', 'markdown', 'Plan')
    await source.createDocument('month/x', 'markdown', 'plan')

    await expect(source.renameDocumentPath('month/x', 'week/x')).rejects.toThrow(
      'Another document here is already called "plan".',
    )
    expect((await source.listDocuments()).map((e) => e.path).sort()).toEqual([
      'month/x',
      'week/plan',
    ])
  })
})
