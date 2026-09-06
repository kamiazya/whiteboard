import { MAX_AUTO_PER_DOCUMENT } from '@kamiazya/whiteboard-history'
import {
  readSpatialCanvas,
  writeSpatialCanvas,
  writeWorkspaceDocumentContent,
} from '@kamiazya/whiteboard-loro-adapter'
import { LoroDoc } from 'loro-crdt'
import { beforeEach, describe, expect, it } from 'vitest'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { BrowserVersionStore } from './browser-version-store.js'
import { BrowserWorkspaceDocs } from './browser-workspace-docs.js'
import { getBrowserWorkspaceId } from './browser-workspace-id.js'
import { FoldingBrowserIndex } from './folding-browser-index.js'

// The claim seeds the db-name seam every opener in this page resolves;
// nothing here needs the name itself now that clearWhiteboardDb reads it.
claimIsolatedWhiteboardDb('browserversionstore')

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
    await clearWhiteboardDb()
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
  it("keeps a saved point's picture, and says on the row that there is one", async () => {
    const { index, workspaceId, documentId } = await seedDocument('canvas-a')
    const docs = new BrowserWorkspaceDocs()
    await writeContent(docs, documentId, 'drawn')
    const store = new BrowserVersionStore({ docs, index })
    const saved = await store.save(workspaceId, 'canvas-a', { label: 'with a picture' })

    // A row says it has none until one lands, which is what the panel reads
    // to decide whether to leave room for a picture at all.
    expect((await store.list(workspaceId, 'canvas-a'))[0]?.hasThumbnail).toBe(false)

    await store.putThumbnail(
      workspaceId,
      'canvas-a',
      saved.id,
      new Blob(['png-ish'], {
        type: 'image/png',
      }),
    )

    // A reload, because a picture that lives only in memory is not kept.
    const reloaded = new BrowserVersionStore({
      docs: new BrowserWorkspaceDocs(),
      index: new FoldingBrowserIndex(),
    })
    expect((await reloaded.list(workspaceId, 'canvas-a'))[0]?.hasThumbnail).toBe(true)
    const blob = await reloaded.loadThumbnail(workspaceId, 'canvas-a', saved.id)
    expect(await blob?.text()).toBe('png-ish')
  })

  it("refuses a picture belonging to another document's history", async () => {
    const { index, workspaceId, documentId } = await seedDocument('canvas-a')
    const other = await index.createDocument({ workspaceId, path: 'canvas-b', kind: 'spatial' })
    const docs = new BrowserWorkspaceDocs()
    await writeContent(docs, documentId, 'mine')
    await writeContent(docs, other.documentId, 'theirs')
    const store = new BrowserVersionStore({ docs, index })
    const theirs = await store.save(workspaceId, 'canvas-b', {})
    await store.putThumbnail(workspaceId, 'canvas-b', theirs.id, new Blob(['theirs']))

    // The refusal loadPast makes, for the same reason: an id alone must not
    // read a history that is not this document's.
    expect(await store.loadThumbnail(workspaceId, 'canvas-a', theirs.id)).toBeNull()
  })
})

describe('automatic checkpoints', () => {
  beforeEach(async () => {
    await clearWhiteboardDb()
  })

  it('records a checkpoint as automatic and on the branch it was taken from', async () => {
    const { index, workspaceId, documentId } = await seedDocument('canvas-auto')
    const docs = new BrowserWorkspaceDocs()
    await writeContent(docs, documentId, 'work')
    const store = new BrowserVersionStore({ docs, index })

    const auto = await store.save(workspaceId, 'canvas-auto', {
      auto: true,
      branchName: 'wide-layout',
    })

    expect(auto).toMatchObject({ auto: true, branchName: 'wide-layout' })
    // Read back rather than trusting the return: the row is what the panel
    // lists, and a field the save answers but does not persist would pass a
    // return-value assertion and show nothing in the history.
    const listed = await new BrowserVersionStore({ docs, index }).list(workspaceId, 'canvas-auto')
    expect(listed).toEqual([expect.objectContaining({ auto: true, branchName: 'wide-layout' })])
  })

  it("leaves a manual save's own defaults alone, so a row written before this reads as it did", async () => {
    const { index, workspaceId, documentId } = await seedDocument('canvas-manual')
    const docs = new BrowserWorkspaceDocs()
    await writeContent(docs, documentId, 'work')
    const store = new BrowserVersionStore({ docs, index })

    const manual = await store.save(workspaceId, 'canvas-manual', { label: 'by hand' })

    expect(manual).toMatchObject({ auto: false, branchName: 'main' })
  })

  it('keeps the newest 50 automatic checkpoints and lets the older ones go, sparing manual saves', async () => {
    const { index, workspaceId, documentId } = await seedDocument('canvas-cap')
    const docs = new BrowserWorkspaceDocs()
    await writeContent(docs, documentId, 'work')
    const store = new BrowserVersionStore({ docs, index })

    const manual = await store.save(workspaceId, 'canvas-cap', { label: 'by hand' })
    for (let i = 0; i < MAX_AUTO_PER_DOCUMENT + 3; i += 1) {
      await store.save(workspaceId, 'canvas-cap', { auto: true })
    }

    const rows = await store.list(workspaceId, 'canvas-cap')
    const autos = rows.filter((r) => r.auto)
    expect(autos).toHaveLength(MAX_AUTO_PER_DOCUMENT)
    // A manual save is not a checkpoint and the cap never reaches it.
    expect(rows.filter((r) => !r.auto).map((r) => r.id)).toEqual([manual.id])
  })

  it('never sweeps a restore merge or the point it names, even past the cap', async () => {
    const { index, workspaceId, documentId } = await seedDocument('canvas-lineage')
    const docs = new BrowserWorkspaceDocs()
    await writeContent(docs, documentId, 'work')
    const store = new BrowserVersionStore({ docs, index })

    // The two ends of a restore, both automatic and both the OLDEST rows, so
    // an unqualified cap would take them first. Lineage is what spares them:
    // the merge names its source, and the source is named by the merge.
    const named = await store.save(workspaceId, 'canvas-lineage', { auto: true })
    const merge = await store.save(workspaceId, 'canvas-lineage', {
      auto: true,
      restoredFrom: named.id,
    })
    for (let i = 0; i < MAX_AUTO_PER_DOCUMENT + 1; i += 1) {
      await store.save(workspaceId, 'canvas-lineage', { auto: true })
    }

    const ids = new Set((await store.list(workspaceId, 'canvas-lineage')).map((r) => r.id))
    expect(ids.has(merge.id)).toBe(true)
    expect(ids.has(named.id)).toBe(true)
  })
})
