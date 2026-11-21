/**
 * What a read serves after a write that failed, and after a path moved: always
 * the record's own content, never a copy held from before. Holds whether or not
 * anything caches a document between the write and the read.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSpatialCanvas, writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import { nodeText } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { DocumentStoreWorkspaceDocs } from '@kamiazya/whiteboard-workspace-index'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

let tempDir: string
vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  getDataDir: () => tempDir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { saveDocument, loadDocument, renameDocumentPath, _clearWorkspaceDocCacheForTests } =
  await import('./document-store.js')
const { createIsolatedDb } = await import('./db/test-helpers.js')

const WS = '0104Y7DY19FTA30KQYKDRRMNBN'
let handle: Awaited<ReturnType<typeof createIsolatedDb>>

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'doc-store-reads-'))
  handle = await createIsolatedDb({ dataDir: tempDir })
  _clearWorkspaceDocCacheForTests()
})
afterEach(async () => {
  vi.restoreAllMocks()
  await handle.dispose()
  await rm(tempDir, { recursive: true, force: true })
})

function canvasDoc(text: string): LoroDoc {
  const doc = new LoroDoc()
  writeSpatialCanvas(doc, {
    nodes: [textNode({ id: 'n1', x: 0, y: 0, width: 80, height: 40, text })],
    edges: [],
  })
  return doc
}

async function textAt(path: string): Promise<string | undefined> {
  const canvas = readSpatialCanvas(await loadDocument(WS, path))
  const node = canvas.nodes.find((candidate) => candidate.id === 'n1')
  return node === undefined ? undefined : nodeText(node)
}

it('serves the stored content after a save that failed to persist', async () => {
  await saveDocument(WS, 'kept', canvasDoc('stored'), { kind: 'spatial' })

  const persist = vi
    .spyOn(DocumentStoreWorkspaceDocs.prototype, 'save')
    .mockRejectedValueOnce(new Error('disk full'))
  await expect(saveDocument(WS, 'kept', canvasDoc('refused'), { overwrite: true })).rejects.toThrow(
    'disk full',
  )
  persist.mockRestore()

  expect(await textAt('kept')).toBe('stored')
})

it('serves the stored content after a save whose source could not be read', async () => {
  await saveDocument(WS, 'kept', canvasDoc('stored'), { kind: 'spatial' })
  const unreadable = new LoroDoc()
  Object.defineProperty(unreadable, 'toJSON', {
    value: () => {
      throw new Error('this source cannot be read')
    },
  })

  await expect(saveDocument(WS, 'kept', unreadable, { overwrite: true })).rejects.toThrow(
    'this source cannot be read',
  )

  expect(await textAt('kept')).toBe('stored')
})

it('serves a moved subtree at its new paths and nothing at the old ones', async () => {
  await saveDocument(WS, 'a/x', canvasDoc('under a'), { kind: 'spatial' })
  await saveDocument(WS, 'a', canvasDoc('a itself'), { kind: 'spatial' })
  expect(await textAt('a/x')).toBe('under a')

  await renameDocumentPath(WS, 'a', 'b')

  expect(await textAt('b/x')).toBe('under a')
  expect(await textAt('b')).toBe('a itself')
  expect(await textAt('a/x')).toBeUndefined()
  expect(await textAt('a')).toBeUndefined()
})

it('serves what a path later placed anew holds, not what the path held before', async () => {
  await saveDocument(WS, 'a', canvasDoc('first'), { kind: 'spatial' })
  await renameDocumentPath(WS, 'a', 'b')
  await saveDocument(WS, 'a', canvasDoc('second'), { kind: 'spatial' })

  expect(await textAt('a')).toBe('second')
  expect(await textAt('b')).toBe('first')
})
