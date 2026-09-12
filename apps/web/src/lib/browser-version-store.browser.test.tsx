import { MAX_AUTO_PER_DOCUMENT } from '@kamiazya/whiteboard-history'
import {
  readSpatialCanvas,
  writeSpatialCanvas,
  writeWorkspaceDocumentContent,
} from '@kamiazya/whiteboard-loro-adapter'
import type { DocumentIndex } from '@kamiazya/whiteboard-ports'
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

/**
 * The question the checkpoint scheduler asks before writing a row, answered
 * here rather than by comparing frontiers across the two — a version's
 * frontier is the RECORD's, and the doc a scheduler holds is not, so a
 * comparison spanning that boundary is never equal whatever the state.
 */
describe('has this state already been checkpointed', () => {
  beforeEach(async () => {
    await clearWhiteboardDb()
  })

  it('says no with no versions, yes right after one, and no again once the record moves', async () => {
    const { index, workspaceId, documentId } = await seedDocument('canvas-a')
    const docs = new BrowserWorkspaceDocs()
    await writeContent(docs, documentId, 'first')
    const store = new BrowserVersionStore({ docs, index })

    // Nothing saved yet: a document with no history has no point to
    // duplicate, so the first checkpoint must always go through.
    expect(await store.isUnchangedSinceLastVersion(workspaceId, 'canvas-a')).toBe(false)

    await store.save(workspaceId, 'canvas-a', { auto: true })
    // Nothing has happened since, so a second row would hold what the first
    // one holds. This is the reconnect and the after-a-bookmark case both:
    // the store is asked, so no scheduler's memory is involved.
    expect(await store.isUnchangedSinceLastVersion(workspaceId, 'canvas-a')).toBe(true)

    await writeContent(docs, documentId, 'second')
    expect(await store.isUnchangedSinceLastVersion(workspaceId, 'canvas-a')).toBe(false)
  })

  /**
   * The question is about ONE document, and a record frontier cannot answer
   * it: every document in a workspace lives in one record, so a sibling's
   * edit moves the frontier too. Measured before the fix on the daemon twin:
   * five sibling edits, five wrong answers. The cost is not a stray row here
   * and there — in a workspace anybody is working in, the scheduler cannot
   * tell an untouched document from an edited one at all.
   */
  it('stays yes while only a sibling document is edited', async () => {
    const { index, workspaceId, documentId } = await seedDocument('canvas-a')
    const sibling = await index.createDocument({
      workspaceId,
      path: 'canvas-b',
      kind: 'spatial',
    })
    const docs = new BrowserWorkspaceDocs()
    await writeContent(docs, documentId, 'mine')
    const store = new BrowserVersionStore({ docs, index })

    await store.save(workspaceId, 'canvas-a', { auto: true })
    expect(await store.isUnchangedSinceLastVersion(workspaceId, 'canvas-a')).toBe(true)

    for (const text of ['one', 'two', 'three', 'four', 'five']) {
      await writeContent(docs, sibling.documentId, text)
      expect(await store.isUnchangedSinceLastVersion(workspaceId, 'canvas-a')).toBe(true)
    }
  })

  /**
   * The digest is taken from the RECORD, so the answer does not depend on
   * which index a caller passed.
   *
   * `DocumentEntry.contentDigest` is optional on the port because an index
   * that does not hold the content cannot derive one — and this app wires
   * exactly such an index (`IdbDocumentIndex`, used by `browser-workspaces`
   * and by the document page's own tests). A store that read the digest off
   * the placement answered `undefined === <digest>` forever under one of
   * them: every save refused or every point read as changed, depending on
   * which way it was written. Both are silent in the app and neither is
   * visible to a test that only ever passes the tree-backed index.
   */
  it('answers the same through an index that cannot identify content', async () => {
    const { index, workspaceId, documentId } = await seedDocument('canvas-a')
    const docs = new BrowserWorkspaceDocs()
    await writeContent(docs, documentId, 'mine')

    const digestless: Pick<DocumentIndex, 'resolveDocument'> = {
      async resolveDocument(input) {
        const entry = await index.resolveDocument(input)
        if (entry === null) return null
        const { contentDigest: _dropped, ...rest } = entry
        return rest
      },
    }
    const store = new BrowserVersionStore({ docs, index: digestless })

    await store.save(workspaceId, 'canvas-a', { auto: true })
    expect(await store.isUnchangedSinceLastVersion(workspaceId, 'canvas-a')).toBe(true)

    await writeContent(docs, documentId, 'edited')
    expect(await store.isUnchangedSinceLastVersion(workspaceId, 'canvas-a')).toBe(false)
  })

  /**
   * A point's digest and its frontier must describe ONE state.
   *
   * They used to come from two reads — the digest off the resolved placement,
   * the frontier off a separately opened record — so a write landing between
   * them recorded a digest of the state BEFORE it against a frontier pointing
   * after it. The checkpoint then disagreed with itself: restoring it gave one
   * state, and the unchanged check compared against another, so the scheduler
   * took a second point of the state it had just recorded.
   *
   * Both now come from the same opened record, which nothing else can mutate
   * — but that is structure, and structure is what a later edit undoes without
   * any other test noticing.
   */
  it('records the digest of the state its frontier points at when a write lands mid-save', async () => {
    const { index, workspaceId, documentId } = await seedDocument('canvas-a')
    const docs = new BrowserWorkspaceDocs()
    await writeContent(docs, documentId, 'before')

    // Lands the write inside the window: after the placement lookup, before
    // the record is opened.
    let raced = false
    const racing: Pick<DocumentIndex, 'resolveDocument'> = {
      async resolveDocument(input) {
        const entry = await index.resolveDocument(input)
        if (!raced) {
          raced = true
          await writeContent(docs, documentId, 'landed mid-save')
        }
        return entry
      },
    }

    await new BrowserVersionStore({ docs, index: racing }).save(workspaceId, 'canvas-a', {
      auto: true,
    })
    // The window was actually entered; without this the case could pass by
    // never having raced at all.
    expect(raced).toBe(true)

    // The record was opened after that write, so the point holds it. Read
    // through the REAL index, so the answer is about the stored row rather
    // than about the racing wrapper.
    const store = new BrowserVersionStore({ docs, index })
    expect(await store.isUnchangedSinceLastVersion(workspaceId, 'canvas-a')).toBe(true)
  })

  it('answers a manual save the same way, since a bookmark is a point too', async () => {
    const { index, workspaceId, documentId } = await seedDocument('canvas-a')
    const docs = new BrowserWorkspaceDocs()
    await writeContent(docs, documentId, 'first')
    const store = new BrowserVersionStore({ docs, index })

    await store.save(workspaceId, 'canvas-a', { label: 'a point I named' })

    expect(await store.isUnchangedSinceLastVersion(workspaceId, 'canvas-a')).toBe(true)
  })
})
