import { MAX_AUTO_PER_DOCUMENT } from '@kamiazya/whiteboard-history'
import {
  contentDigestOfDocument,
  countSpatialNodes,
  loadCrdtEngine,
  projectWorkspaceDocument,
  readSpatialCanvas,
  writeSpatialCanvas,
  writeWorkspaceDocumentContent,
} from '@kamiazya/whiteboard-loro-adapter'
import { nodeText } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import type { DocumentIndex } from '@kamiazya/whiteboard-ports'
import { decodeFrontiers, encodeFrontiers, LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { BrowserDocumentIndex } from './browser-document-index.js'
import { VERSIONS_STORE } from './browser-idb.js'
import { BrowserVersionStore, savedVersionRows } from './browser-version-store.js'
import { BrowserWorkspaceDocs } from './browser-workspace-docs.js'
import { getBrowserWorkspaceId } from './browser-workspace-id.js'
import { BrowserWorkspaceRecords } from './browser-workspace-records.js'
import { inTransaction, request } from './idb-tx.js'

// The claim seeds the db-name seam every opener in this page resolves;
// nothing here needs the name itself now that clearWhiteboardDb reads it.
claimIsolatedWhiteboardDb('browserversionstore')

function textDoc(text: string): LoroDoc {
  const doc = new LoroDoc()
  writeSpatialCanvas(doc, {
    nodes: [textNode({ id: 'n1', x: 0, y: 0, width: 80, height: 40, text })],
    edges: [],
  })
  doc.commit()
  return doc
}

/** The text of the first node the version held, or undefined when the store lends nothing. */
async function pastTextOf(
  store: BrowserVersionStore,
  workspaceId: string,
  path: string,
  versionId: string,
): Promise<string | undefined> {
  const text = await store.withPast(workspaceId, path, versionId, async (held) => {
    const node = (await held.canvas()).nodes[0]
    return node === undefined ? '' : nodeText(node)
  })
  return text ?? undefined
}

/** Writes `text` as the document's content into the stored record, as an edit would. */
async function writeContent(docs: BrowserWorkspaceDocs, documentId: string, text: string) {
  const record = await docs.open(getBrowserWorkspaceId())
  if (record === null) throw new Error('no record')
  writeWorkspaceDocumentContent(record, documentId, textDoc(text))
  await docs.save(getBrowserWorkspaceId(), record)
}

async function seedDocument(path: string) {
  const index = new BrowserDocumentIndex()
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
    const store = new BrowserVersionStore({ docs: new BrowserWorkspaceRecords(), index })

    const first = await store.save(workspaceId, 'canvas-a', { label: 'first' })
    await writeContent(docs, documentId, 'second')
    const second = await store.save(workspaceId, 'canvas-a', { label: 'second' })
    await writeContent(docs, documentId, 'moved on')

    expect(first).toMatchObject({
      path: 'canvas-a',
      label: 'first',
      auto: false,
      elementCount: 1,
    })

    // A reload: nothing held in memory survives, only IndexedDB.
    const reloaded = new BrowserVersionStore({
      docs: new BrowserWorkspaceRecords(),
      index: new BrowserDocumentIndex(),
    })
    const listed = await reloaded.list(workspaceId, 'canvas-a')
    expect(listed.map((v) => v.id)).toEqual([second.id, first.id])
    expect(await pastTextOf(reloaded, workspaceId, 'canvas-a', first.id)).toBe('first')
    expect(await pastTextOf(reloaded, workspaceId, 'canvas-a', second.id)).toBe('second')
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
    const store = new BrowserVersionStore({ docs: new BrowserWorkspaceRecords(), index })
    const theirs = await store.save(workspaceId, 'canvas-b', { label: 'theirs' })

    expect(await pastTextOf(store, workspaceId, 'canvas-a', theirs.id)).toBeUndefined()
    expect(await pastTextOf(store, workspaceId, 'canvas-a', 'no-such-version')).toBeUndefined()
    expect(await store.list(workspaceId, 'canvas-a')).toEqual([])
  })
})

describe('automatic checkpoints', () => {
  beforeEach(async () => {
    await clearWhiteboardDb()
  })

  it('records a checkpoint as automatic and keeps that on the row the panel lists', async () => {
    const { index, workspaceId, documentId } = await seedDocument('canvas-auto')
    const docs = new BrowserWorkspaceDocs()
    await writeContent(docs, documentId, 'work')
    const store = new BrowserVersionStore({ docs: new BrowserWorkspaceRecords(), index })

    const auto = await store.save(workspaceId, 'canvas-auto', { auto: true })

    expect(auto).toMatchObject({ auto: true })
    expect(auto).not.toHaveProperty('branchName')
    // Read back rather than trusting the return: the row is what the panel
    // lists, and a field the save answers but does not persist would pass a
    // return-value assertion and show nothing in the history.
    const listed = await new BrowserVersionStore({
      docs: new BrowserWorkspaceRecords(),
      index,
    }).list(workspaceId, 'canvas-auto')
    expect(listed).toEqual([expect.objectContaining({ auto: true })])
  })

  it("leaves a manual save's own defaults alone, so a row written before this reads as it did", async () => {
    const { index, workspaceId, documentId } = await seedDocument('canvas-manual')
    const docs = new BrowserWorkspaceDocs()
    await writeContent(docs, documentId, 'work')
    const store = new BrowserVersionStore({ docs: new BrowserWorkspaceRecords(), index })

    const manual = await store.save(workspaceId, 'canvas-manual', { label: 'by hand' })

    expect(manual).toMatchObject({ auto: false })
  })

  it('keeps the newest 50 automatic checkpoints and lets the older ones go, sparing manual saves', async () => {
    const { index, workspaceId, documentId } = await seedDocument('canvas-cap')
    const docs = new BrowserWorkspaceDocs()
    await writeContent(docs, documentId, 'work')
    const store = new BrowserVersionStore({ docs: new BrowserWorkspaceRecords(), index })

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
    const store = new BrowserVersionStore({ docs: new BrowserWorkspaceRecords(), index })

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
    const store = new BrowserVersionStore({ docs: new BrowserWorkspaceRecords(), index })

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
    const store = new BrowserVersionStore({ docs: new BrowserWorkspaceRecords(), index })

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
   * that does not hold the content cannot derive one — and this app's legacy
   * rows were exactly that. A store that read the digest off
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
    const store = new BrowserVersionStore({
      docs: new BrowserWorkspaceRecords(),
      index: digestless,
    })

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

    await new BrowserVersionStore({ docs: new BrowserWorkspaceRecords(), index: racing }).save(
      workspaceId,
      'canvas-a',
      {
        auto: true,
      },
    )
    // The window was actually entered; without this the case could pass by
    // never having raced at all.
    expect(raced).toBe(true)

    // The record was opened after that write, so the point holds it. Read
    // through the REAL index, so the answer is about the stored row rather
    // than about the racing wrapper.
    const store = new BrowserVersionStore({ docs: new BrowserWorkspaceRecords(), index })
    expect(await store.isUnchangedSinceLastVersion(workspaceId, 'canvas-a')).toBe(true)
  })

  it('answers a manual save the same way, since a bookmark is a point too', async () => {
    const { index, workspaceId, documentId } = await seedDocument('canvas-a')
    const docs = new BrowserWorkspaceDocs()
    await writeContent(docs, documentId, 'first')
    const store = new BrowserVersionStore({ docs: new BrowserWorkspaceRecords(), index })

    await store.save(workspaceId, 'canvas-a', { label: 'a point I named' })

    expect(await store.isUnchangedSinceLastVersion(workspaceId, 'canvas-a')).toBe(true)
  })
})

describe('rows shared with the earlier store', () => {
  beforeEach(async () => {
    await clearWhiteboardDb()
  })

  // What the previous store wrote for a save, computed the way it computed it.
  async function legacyRow(workspaceId: string, documentId: string, docs: BrowserWorkspaceDocs) {
    const record = await docs.open(workspaceId)
    if (record === null) throw new Error('no record')
    const projection = projectWorkspaceDocument(record, documentId)
    if (projection === null) throw new Error('no content')
    return {
      id: 'v-legacy',
      workspaceId,
      documentId,
      path: 'canvas-a',
      createdAt: 1,
      elementCount: countSpatialNodes(projection),
      frontiers: new Uint8Array(encodeFrontiers(record.oplogFrontiers())),
      contentDigest: contentDigestOfDocument(projection),
    }
  }

  it('reads a row the earlier store wrote: its digest, point and content', async () => {
    const { index, workspaceId, documentId } = await seedDocument('canvas-a')
    const docs = new BrowserWorkspaceDocs()
    await writeContent(docs, documentId, 'as saved')
    const row = await legacyRow(workspaceId, documentId, docs)
    await inTransaction(undefined, [VERSIONS_STORE], 'readwrite', (tx) =>
      request(tx.objectStore(VERSIONS_STORE).put(row)),
    )
    const store = new BrowserVersionStore({ docs: new BrowserWorkspaceRecords(), index })

    expect(await store.isUnchangedSinceLastVersion(workspaceId, 'canvas-a')).toBe(true)
    await writeContent(docs, documentId, 'edited since')
    expect(await store.isUnchangedSinceLastVersion(workspaceId, 'canvas-a')).toBe(false)
    expect(await pastTextOf(store, workspaceId, 'canvas-a', 'v-legacy')).toBe('as saved')
  })

  it('writes a row the earlier store reads: same point, digest, count, content', async () => {
    const { index, workspaceId, documentId } = await seedDocument('canvas-a')
    const docs = new BrowserWorkspaceDocs()
    await writeContent(docs, documentId, 'as saved')
    const store = new BrowserVersionStore({ docs: new BrowserWorkspaceRecords(), index })
    const entry = await store.save(workspaceId, 'canvas-a')
    const before = await legacyRow(workspaceId, documentId, docs)
    await writeContent(docs, documentId, 'edited since')

    const [row] = await savedVersionRows(workspaceId)

    expect(row).toMatchObject({
      id: entry.id,
      contentDigest: before.contentDigest,
      elementCount: before.elementCount,
    })
    expect(row?.frontiers).toEqual(before.frontiers)
    // The previous store's own read of a past point: check a copy out at the frontiers.
    const record = await docs.open(workspaceId)
    if (record === null || row === undefined) throw new Error('nothing stored')
    const past = LoroDoc.fromSnapshot(record.export({ mode: 'snapshot' }))
    past.checkout(decodeFrontiers(row.frontiers))
    const projected = projectWorkspaceDocument(past, documentId)
    const node = projected === null ? undefined : readSpatialCanvas(projected).nodes[0]
    expect(node === undefined ? undefined : nodeText(node)).toBe('as saved')
  })
})

/**
 * Every engine handle a call opens is given back. A handle left open holds the
 * whole workspace record in memory for the life of the page.
 */
async function handlesOpenedAndClosed(run: () => Promise<unknown>) {
  const engine = await loadCrdtEngine()
  const opened = vi.spyOn(engine, 'open')
  const forked = vi.spyOn(engine, 'fork')
  const closed = vi.spyOn(engine, 'close')
  await run().catch(() => undefined)
  const made = (spy: { mock: { results: Array<{ type: string }> } }) =>
    spy.mock.results.filter((result) => result.type === 'return').length
  return { opened: made(opened) + made(forked), closed: closed.mock.calls.length }
}

describe('a document the index places and the record does not hold', () => {
  beforeEach(async () => {
    await clearWhiteboardDb()
  })

  it('refuses to save it, naming where the content is missing, and finds it never unchanged', async () => {
    const { index, workspaceId } = await seedDocument('canvas-a')
    const ghost: Pick<DocumentIndex, 'resolveDocument'> = {
      resolveDocument: async (input) => {
        const entry = await index.resolveDocument(input)
        return entry === null ? null : { ...entry, documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAZ' }
      },
    }
    const store = new BrowserVersionStore({ docs: new BrowserWorkspaceRecords(), index: ghost })

    await expect(store.save(workspaceId, 'canvas-a')).rejects.toThrow(
      'no content for canvas-a in the workspace record',
    )
    expect(await store.isUnchangedSinceLastVersion(workspaceId, 'canvas-a')).toBe(false)
  })
})

describe('BrowserVersionStore gives back every engine handle it opens', () => {
  beforeEach(async () => {
    await clearWhiteboardDb()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  async function savedStore() {
    const { index, workspaceId, documentId } = await seedDocument('canvas-a')
    const docs = new BrowserWorkspaceDocs()
    await writeContent(docs, documentId, 'first')
    const store = new BrowserVersionStore({ docs: new BrowserWorkspaceRecords(), index })
    const saved = await store.save(workspaceId, 'canvas-a')
    return { store, workspaceId, saved }
  }

  it('on a save, an unchanged check, and a read of a past point', async () => {
    const { store, workspaceId, saved } = await savedStore()

    const handles = await handlesOpenedAndClosed(async () => {
      await store.save(workspaceId, 'canvas-a')
      await store.isUnchangedSinceLastVersion(workspaceId, 'canvas-a')
      await pastTextOf(store, workspaceId, 'canvas-a', saved.id)
    })

    expect(handles.opened).toBeGreaterThanOrEqual(4)
    expect(handles.closed).toBe(handles.opened)
  })

  it('when the reader of a past point throws', async () => {
    const { store, workspaceId, saved } = await savedStore()

    const handles = await handlesOpenedAndClosed(() =>
      store.withPast(workspaceId, 'canvas-a', saved.id, async () => {
        throw new Error('the reader failed')
      }),
    )

    expect(handles.opened).toBeGreaterThanOrEqual(2)
    expect(handles.closed).toBe(handles.opened)
  })
})
