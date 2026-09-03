import {
  readSpatialCanvas,
  writeSpatialCanvas,
  writeWorkspaceDocumentContent,
} from '@kamiazya/whiteboard-loro-adapter'
import { LoroDoc } from 'loro-crdt'
import { beforeEach, describe, expect, it } from 'vitest'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { BrowserVersionStore } from './browser-version-store.js'
import { BrowserWorkspaceDocs } from './browser-workspace-docs.js'
import { getBrowserWorkspaceId } from './browser-workspace-id.js'
import { FoldingBrowserIndex } from './folding-browser-index.js'

const ISOLATED_DB = claimIsolatedWhiteboardDb('browserversionstore')

function clearDb(): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(ISOLATED_DB)
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
  })
}

function textDoc(text: string): LoroDoc {
  const doc = new LoroDoc()
  writeSpatialCanvas(doc, {
    nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 80, height: 40, text }],
    edges: [],
  })
  doc.commit()
  return doc
}

function textOf(doc: LoroDoc | null): string | undefined {
  if (doc === null) return undefined
  const node = readSpatialCanvas(doc).nodes[0]
  return node?.type === 'text' ? node.text : undefined
}

/** Writes `text` as the document's content into the stored record, as an edit would. */
async function writeContent(docs: BrowserWorkspaceDocs, documentId: string, text: string) {
  const record = await docs.open(getBrowserWorkspaceId())
  if (record === null) throw new Error('no record')
  writeWorkspaceDocumentContent(record, documentId, textDoc(text))
  await docs.save(getBrowserWorkspaceId(), record)
}

async function seedDocument(path: string) {
  const index = new FoldingBrowserIndex()
  const workspaceId = getBrowserWorkspaceId()
  await index.createWorkspace({ workspaceId })
  const { documentId } = await index.createDocument({ workspaceId, path, kind: 'spatial' })
  return { index, workspaceId, documentId }
}

describe('BrowserVersionStore (real IndexedDB)', () => {
  beforeEach(async () => {
    await clearDb()
  })

  it('saves a frontier, lists newest first, and checks the past out through a fresh store', async () => {
    const { index, workspaceId, documentId } = await seedDocument('canvas-a')
    const docs = new BrowserWorkspaceDocs()
    await writeContent(docs, documentId, 'first')
    const store = new BrowserVersionStore({ docs, index })

    const first = await store.save(workspaceId, 'canvas-a', { label: 'first' })
    await writeContent(docs, documentId, 'second')
    const second = await store.save(workspaceId, 'canvas-a', { label: 'second' })
    await writeContent(docs, documentId, 'moved on')

    expect(first).toMatchObject({
      path: 'canvas-a',
      label: 'first',
      auto: false,
      elementCount: 1,
      branchName: 'main',
      hasThumbnail: false,
    })

    // A reload: nothing held in memory survives, only IndexedDB.
    const reloaded = new BrowserVersionStore({
      docs: new BrowserWorkspaceDocs(),
      index: new FoldingBrowserIndex(),
    })
    const listed = await reloaded.list(workspaceId, 'canvas-a')
    expect(listed.map((v) => v.id)).toEqual([second.id, first.id])
    expect(textOf(await reloaded.loadPast(workspaceId, 'canvas-a', first.id))).toBe('first')
    expect(textOf(await reloaded.loadPast(workspaceId, 'canvas-a', second.id))).toBe('second')
    // The live document is untouched by reading history.
    const record = await docs.open(workspaceId)
    expect(record).not.toBeNull()
  })

  it("answers null for a version that belongs to another document's history", async () => {
    const { index, workspaceId, documentId } = await seedDocument('canvas-a')
    const other = await index.createDocument({ workspaceId, path: 'canvas-b', kind: 'spatial' })
    const docs = new BrowserWorkspaceDocs()
    await writeContent(docs, documentId, 'mine')
    await writeContent(docs, other.documentId, 'theirs')
    const store = new BrowserVersionStore({ docs, index })
    const theirs = await store.save(workspaceId, 'canvas-b', { label: 'theirs' })

    expect(await store.loadPast(workspaceId, 'canvas-a', theirs.id)).toBeNull()
    expect(await store.loadPast(workspaceId, 'canvas-a', 'no-such-version')).toBeNull()
    expect(await store.list(workspaceId, 'canvas-a')).toEqual([])
  })
})
