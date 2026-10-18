/**
 * A save writes into the CACHED workspace record before persisting it — the
 * node a new path needs, then the content — so a throw between the two would
 * leave those ops in the cache, where the next save of any document in the
 * workspace persists them as though this one had succeeded.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveWorkspaceDocument, writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
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

const { saveDocument, _clearWorkspaceDocCacheForTests } = await import('./document-store.js')
const { clearDocCacheForTests } = await import('./doc-cache.js')
const { createIsolatedDb } = await import('./db/test-helpers.js')
const { getDb } = await import('./db/index.js')
const { LibsqlDocumentStore } = await import('./libsql/libsql-document-store.js')

let handle: Awaited<ReturnType<typeof createIsolatedDb>>

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'doc-store-failed-write-'))
  handle = await createIsolatedDb({ dataDir: tempDir })
  clearDocCacheForTests()
  _clearWorkspaceDocCacheForTests()
})
afterEach(async () => {
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

/** A source the content write cannot read, so it throws after the node was placed. */
function unreadableSource(): LoroDoc {
  const doc = new LoroDoc()
  Object.defineProperty(doc, 'toJSON', {
    value: () => {
      throw new Error('this source cannot be read')
    },
  })
  return doc
}

it('a save that throws after placing its node leaves nothing for the next save to persist', async () => {
  await saveDocument('ws', 'kept', canvasDoc('first'), { kind: 'spatial' })

  await expect(
    saveDocument('ws', 'phantom', unreadableSource(), { kind: 'spatial' }),
  ).rejects.toThrow('this source cannot be read')
  await saveDocument('ws', 'kept', canvasDoc('second'), { overwrite: true })

  const stored = await new DocumentStoreWorkspaceDocs(
    new LibsqlDocumentStore(await getDb(tempDir)),
  ).open('ws')
  if (stored === null) throw new Error('the workspace record was never stored')
  expect(resolveWorkspaceDocument(stored, 'kept')).not.toBeNull()
  expect(resolveWorkspaceDocument(stored, 'phantom')).toBeNull()
})
