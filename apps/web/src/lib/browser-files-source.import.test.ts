import 'fake-indexeddb/auto'
import {
  readCoreFacets,
  readMarkdownBody,
  readSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { beforeEach, describe, expect, it } from 'vitest'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { createBrowserFilesSource } from './browser-files-source.js'
import { getBrowserWorkspaceId } from './browser-workspace-id.js'
import { IdbDocumentIndex } from './idb-document-index.js'
import { loadDocumentContent } from './workspace-content.js'

claimIsolatedWhiteboardDb('browser-files-source-import')

async function importedContent(path: string) {
  const source = createBrowserFilesSource()
  const entry = (await source.listDocuments()).find((row) => row.path === path)
  expect(entry).toBeDefined()
  const doc = await loadDocumentContent(entry?.documentId ?? '')
  expect(doc).not.toBeNull()
  return { entry, doc }
}

describe('createBrowserFilesSource — importDocument', () => {
  beforeEach(async () => {
    await clearWhiteboardDb()
    await new IdbDocumentIndex().createWorkspace({ workspaceId: getBrowserWorkspaceId() })
  })

  it('creates a markdown document holding the file body, type, facets and name', async () => {
    const source = createBrowserFilesSource()
    await source.importDocument?.('notes/trip', {
      kind: 'markdown',
      body: '# Trip\n',
      coreFacets: { type: 'plan', tags: ['travel'] },
      facets: {},
      name: 'Trip plan',
      pathBase: 'trip',
    })

    const { entry, doc } = await importedContent('notes/trip')
    expect(entry?.name).toBe('Trip plan')
    expect(entry?.kind).toBe('markdown')
    expect(readMarkdownBody(doc as never)).toBe('# Trip\n')
    expect(readCoreFacets(doc as never)).toMatchObject({ type: 'plan', tags: ['travel'] })
  })

  it('creates a canvas document holding the file nodes', async () => {
    const source = createBrowserFilesSource()
    await source.importDocument?.('board', {
      kind: 'spatial',
      canvas: {
        nodes: [textNode({ id: 'a', x: 0, y: 0, width: 100, height: 50, text: 'hello' })],
        edges: [],
      },
      name: 'board',
      pathBase: 'board',
    })

    const { entry, doc } = await importedContent('board')
    expect(entry?.kind).toBe('spatial')
    expect(readSpatialCanvas(doc as never).nodes.map((n) => n.id)).toEqual(['a'])
  })

  it('refuses a path that is taken and leaves the existing document alone', async () => {
    const source = createBrowserFilesSource()
    await source.createDocument('taken', 'markdown')
    await expect(
      source.importDocument?.('taken', {
        kind: 'markdown',
        body: 'x',
        coreFacets: { type: 'note' },
        facets: {},
        name: undefined,
        pathBase: 'taken',
      }),
    ).rejects.toThrow()
    expect((await source.listDocuments()).filter((row) => row.path === 'taken')).toHaveLength(1)
  })
})
