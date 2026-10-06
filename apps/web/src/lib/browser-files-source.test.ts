/**
 * The browser's `WorkspaceFilesSource` — the adapter that lets the
 * three-pane browser serve a browser-kept workspace, which is the whole point of the seam.
 */
import 'fake-indexeddb/auto'
import {
  trashPurgeRefusal,
  trashRestoreRefusal,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/document'
import {
  writeCoreFacets,
  writeFacets,
  writeMarkdownBody,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import type { DocumentKind, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { STENCIL_LIBRARY_PATH, TAG_LIBRARY_PATH } from '@kamiazya/whiteboard-plugin-visual'
import type { DocumentEntry, ListDocumentsInput } from '@kamiazya/whiteboard-ports'
import { InMemoryDocumentIndex } from '@kamiazya/whiteboard-ports/test-utils'
import { Loro } from 'loro-crdt'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { describeWorkspaceFilesSourceConformance } from '../test-utils/files-source.conformance.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { expectLoggedFailure } from '../test-utils/logged-failures.js'
import { seedLegacyRow } from '../test-utils/seed-legacy-row.js'
import { seedSyncDocument } from '../test-utils/seed-sync-document.js'
import { seedWorkspaceDocumentContent } from '../test-utils/seed-workspace-content.js'
import { ensureBrowserWorkspace } from './browser-document-summary.js'
import { createBrowserFilesSource } from './browser-files-source.js'
import {
  getBrowserWorkspaceId,
  resetBrowserWorkspaceIdForTests,
  resolveBrowserWorkspaceId,
} from './browser-workspace-id.js'
import { FoldingBrowserIndex } from './folding-browser-index.js'
import { IdbDocumentIndex } from './idb-document-index.js'
import { LoroStore } from './loro-store.js'
import { loadDocumentContent } from './workspace-content.js'

claimIsolatedWhiteboardDb('browser-files-source')

describe('createBrowserFilesSource', () => {
  beforeEach(clearWhiteboardDb)

  it('lists a fresh database as empty, not as missing', async () => {
    // Written as the missing-workspace case first, and the test refuted its
    // own premise: the v8+ IndexedDB upgrade seeds the browser workspace row
    // unconditionally, so a fresh database HAS the workspace before anything
    // else touches it. The `WorkspaceMissingError` mapping in the source
    // stays — it guards a state a hand-edited store can still reach — but the
    // reachable first-run behaviour is an empty list.
    //
    // Nothing seeds a workspace here on purpose — that is the point being
    // tested — so `getBrowserWorkspaceId()` has to read the id the fresh
    // database's own v14 upgrade actually minted, not the arbitrary id
    // `claimIsolatedWhiteboardDb` claimed for tests that create their
    // workspace explicitly under it.
    resetBrowserWorkspaceIdForTests()
    await resolveBrowserWorkspaceId()
    await expect(createBrowserFilesSource().listDocuments()).resolves.toEqual([])
  })

  it('lists a legacy row-plane document — the startup fold absorbs it into the tree', async () => {
    // A pre-collapse browser's world: an index row plus a content record,
    // nothing in the workspace tree. The default source folds on first read,
    // so the legacy document lists with its name and kind intact.
    const entry = await seedLegacyRow({
      workspaceId: getBrowserWorkspaceId(),
      path: 'a',
      kind: 'spatial',
      name: 'A',
    })
    await new LoroStore().save(entry.documentId, new Loro().export({ mode: 'snapshot' }))

    const entries = await createBrowserFilesSource().listDocuments()
    expect(entries.map((e) => ({ path: e.path, name: e.name, kind: e.kind }))).toEqual([
      { path: 'a', name: 'A', kind: 'spatial' },
    ])
  })

  it('defaults to the production index: a document only the workspace tree knows is listed', async () => {
    // Production injects FoldingBrowserIndex (App.tsx), whose creates land
    // in the workspace tree and write no legacy row. A default of
    // IdbDocumentIndex would silently list a DIFFERENT store than the app
    // writes to — exactly the split the injectable parameter exists to
    // close, reopened by the default.
    const production = new FoldingBrowserIndex()
    await production.createWorkspace({ workspaceId: getBrowserWorkspaceId() }).catch(() => {})
    await production.createDocument({
      workspaceId: getBrowserWorkspaceId(),
      path: 'tree-only',
      kind: 'markdown',
      name: 'Tree Only',
    })

    const entries = await createBrowserFilesSource().listDocuments()
    expect(entries.map((e) => e.path)).toContain('tree-only')
  })

  it('creates a document with seeded content, like every other browser create', async () => {
    const source = createBrowserFilesSource()
    await new IdbDocumentIndex().createWorkspace({ workspaceId: getBrowserWorkspaceId() })

    await source.createDocument('notes/plan', 'markdown')

    const entries = await source.listDocuments()
    expect(entries.map((e) => e.path)).toEqual(['notes/plan'])
    // Its content is the record's node, stamped: a document with no stamp
    // has no last-edited time.
    const documentId = entries[0]?.documentId ?? ''
    expect(entries[0]?.updatedAt).toBeDefined()
    expect(await loadDocumentContent(documentId)).not.toBeNull()
    // And nothing in the retired per-document store, where a second copy
    // would outlive the document's delete and answer reads for it.
    expect((await new LoroStore().load(documentId)).kind).toBe('not-found')
  })

  it('renames through the index, so the subtree moves with it', async () => {
    const source = createBrowserFilesSource()
    await source.createDocument('plan', 'markdown')
    await source.createDocument('plan/sub', 'markdown')

    await source.renameDocumentPath('plan', 'roadmap')

    const paths = (await source.listDocuments()).map((e) => e.path).sort()
    expect(paths).toEqual(['roadmap', 'roadmap/sub'])
  })

  it('names a document by its ID, and clears the name by absence', async () => {
    // The daemon sibling keys the same call on PATH; both are plain strings,
    // so a swap typechecks and silently renames nothing. The fixture makes
    // the two addresses differ (a nested path never equals an id) so only
    // the id can produce this result.
    const source = createBrowserFilesSource()
    await source.createDocument('plans/roadmap', 'markdown')
    const created = (await source.listDocuments())[0]
    expect(created).toBeDefined()
    if (created === undefined) return

    await source.setDocumentName({ documentId: created.documentId, path: created.path }, 'Roadmap')
    expect((await source.listDocuments())[0]?.name).toBe('Roadmap')

    // Clearing is ABSENCE for the port (the daemon spells it as an empty
    // string) — a reader then falls back to the path's last segment.
    await source.setDocumentName({ documentId: created.documentId, path: created.path }, undefined)
    expect((await source.listDocuments())[0]?.name).toBeUndefined()
  })

  it('reads a markdown document body back', async () => {
    const source = createBrowserFilesSource()
    const entry = await seedLegacyRow({
      workspaceId: getBrowserWorkspaceId(),
      path: 'n',
      kind: 'markdown',
    })
    const doc = new Loro()
    doc.getText('body').insert(0, '# Hello from browser')
    await new LoroStore().save(entry.documentId, doc.export({ mode: 'snapshot' }))

    const markdown = await source.loadMarkdown({ ...entry, kind: 'markdown' })
    expect(markdown.body).toContain('Hello from browser')
  })

  // The document's own mark, off the same read as the body. Both keepers
  // answer this shape — `daemon-files-source.test.ts` holds the other half —
  // because a feature written into one keeper and not the other is an absent
  // test rather than a failing one (coverage-ledger.md).
  it('reads a markdown document’s facets back with its body', async () => {
    const source = createBrowserFilesSource()
    const entry = await seedLegacyRow({
      workspaceId: getBrowserWorkspaceId(),
      path: 'marked',
      kind: 'markdown',
    })
    const doc = new Loro()
    doc.getText('body').insert(0, '# Marked')
    writeFacets(doc, { 'visual.symbol/v0': { kind: 'emoji', char: '📌' } })
    await new LoroStore().save(entry.documentId, doc.export({ mode: 'snapshot' }))

    const markdown = await source.loadMarkdown({ ...entry, kind: 'markdown' })
    expect(markdown.body).toContain('Marked')
    expect(markdown.facets).toEqual({ 'visual.symbol/v0': { kind: 'emoji', char: '📌' } })
  })

  it('answers the CURRENT spatial bytes, deltas folded in', async () => {
    const source = createBrowserFilesSource()
    const entry = await seedLegacyRow({
      workspaceId: getBrowserWorkspaceId(),
      path: 's',
      kind: 'spatial',
    })
    const doc = new Loro()
    doc.getList('elements').push({ id: 'a' })
    doc.commit()
    const snapshot = doc.export({ mode: 'snapshot' })
    const before = doc.version()
    doc.getList('elements').push({ id: 'b' })
    doc.commit()
    await seedSyncDocument(entry.documentId, {
      snapshot,
      deltas: [doc.export({ mode: 'update', from: before })],
    })

    const bytes = await source.loadSpatialSnapshot({ ...entry, kind: 'spatial' })
    const fresh = new Loro()
    fresh.import(bytes)
    // Both elements: a thumbnail of the last snapshot alone would show a
    // document the user is not looking at.
    expect(fresh.getList('elements').toJSON()).toHaveLength(2)
  })
})

describe('createBrowserFilesSource tags', () => {
  beforeEach(clearWhiteboardDb)

  it('surfaces core-facet tags on markdown entries and omits them elsewhere', async () => {
    const tagged = await seedLegacyRow({
      workspaceId: getBrowserWorkspaceId(),
      path: 'tagged',
      kind: 'markdown',
    })
    await seedLegacyRow({
      workspaceId: getBrowserWorkspaceId(),
      path: 'plain',
      kind: 'markdown',
    })

    const doc = new Loro()
    writeCoreFacets(doc, { type: 'note', tags: ['release', 'q3'] })
    await new LoroStore().save(tagged.documentId, doc.export({ mode: 'snapshot' }))

    const entries = await createBrowserFilesSource().listDocuments()
    expect(entries.find((e) => e.path === 'tagged')?.tags).toEqual(['release', 'q3'])
    expect(entries.find((e) => e.path === 'plain')?.tags).toBeUndefined()
    await expectLoggedFailure('startup fold left documents behind')
  })
})

describe('createBrowserFilesSource trash', () => {
  beforeEach(clearWhiteboardDb)

  it('exposes the shared index trash: delete lists it, restore brings it back', async () => {
    const index = new FoldingBrowserIndex()
    await ensureBrowserWorkspace(index)
    const entry = await index.createDocument({
      workspaceId: getBrowserWorkspaceId(),
      path: 'doomed',
      kind: 'spatial',
    })
    await seedWorkspaceDocumentContent(entry.documentId, new Loro().export({ mode: 'snapshot' }))
    const source = createBrowserFilesSource({ index })
    await index.deleteDocument({ workspaceId: getBrowserWorkspaceId(), path: 'doomed' })

    const trash = await source.listTrash?.()
    expect(trash?.map((row) => row.documentId)).toEqual([entry.documentId])

    await source.restoreFromTrash?.(entry.documentId)
    const listed = await source.listDocuments()
    expect(listed.map((row) => row.documentId)).toContain(entry.documentId)
    expect(await source.listTrash?.()).toEqual([])
  })

  it('rejects a restore or purge that found nothing, so the UI can say so', async () => {
    // The index answers null for an id that is not in the trash; swallowing
    // that resolves the button's promise and the section reloads with the
    // row still there — a silent no-op. The daemon path already rejects
    // (its route 404s, in the same words); the browser path must agree.
    const index = new FoldingBrowserIndex()
    await ensureBrowserWorkspace(index)
    const source = createBrowserFilesSource({ index })
    const absent = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

    await expect(source.restoreFromTrash?.(absent)).rejects.toThrow(
      trashRestoreRefusal(absent, null).title,
    )
    await expect(source.purgeFromTrash?.(absent)).rejects.toThrow(trashPurgeRefusal(absent).title)
  })

  // The daemon answers 409 in the same words for the same case: the id is
  // live, so the restore has nothing to bring back and "not found" would lie.
  it('refuses to restore a document the workspace already places, naming its path', async () => {
    const index = new FoldingBrowserIndex()
    await ensureBrowserWorkspace(index)
    const entry = await index.createDocument({
      workspaceId: getBrowserWorkspaceId(),
      path: 'notes/live',
      kind: 'markdown',
    })
    const source = createBrowserFilesSource({ index })

    await expect(source.restoreFromTrash?.(entry.documentId)).rejects.toThrow(
      trashRestoreRefusal(entry.documentId, 'notes/live').title,
    )
  })

  it('stays capability-less over an index that keeps no trash', async () => {
    // An index with no listTrash/restoreDocument, so the source must not
    // offer the affordance it could not honour.
    const source = createBrowserFilesSource({ index: new InMemoryDocumentIndex() })
    expect(source.listTrash).toBeUndefined()
    expect(source.restoreFromTrash).toBeUndefined()
  })
})

describe('createBrowserFilesSource search', () => {
  beforeEach(clearWhiteboardDb)

  /**
   * The keeper-parity case. The daemon's answer to this is pinned by
   * `search-quality.test.ts`'s `emoji` category, and a capability that
   * lands on one keeper and not the other is an ABSENT test rather than a
   * failing one — every suite stays green over it. So the browser says it
   * here, in its own words.
   *
   * Measured before the expander existed: `packages/search`'s word pattern
   * is `[\p{L}\p{N}]+`, so a raw emoji contributes no token and a document
   * whose point is the picture was findable by nothing.
   */
  it('finds a document by what its emoji is called, in either language', async () => {
    const index = new FoldingBrowserIndex()
    await ensureBrowserWorkspace(index)
    const entry = await index.createDocument({
      workspaceId: getBrowserWorkspaceId(),
      path: 'notes/untitled-1',
      kind: 'markdown',
      name: '打ち上げメモ',
    })
    const doc = new Loro()
    writeMarkdownBody(doc, '次のリリースは 🚀 で行く。')
    await seedWorkspaceDocumentContent(entry.documentId, doc.export({ mode: 'snapshot' }))
    const source = createBrowserFilesSource({ index })

    const byEnglish = await source.searchDocuments('rocket')
    expect(byEnglish.map((hit) => hit.document.path)).toEqual(['notes/untitled-1'])

    const byJapanese = await source.searchDocuments('ロケット')
    expect(byJapanese.map((hit) => hit.document.path)).toEqual(['notes/untitled-1'])
  })

  // The daemon's spelling is `extract.test.ts`: both keepers read content
  // through `readDocumentContent`, and this holds the browser's half.
  it('finds a document by a word only its description holds', async () => {
    const index = new FoldingBrowserIndex()
    await ensureBrowserWorkspace(index)
    const entry = await index.createDocument({
      workspaceId: getBrowserWorkspaceId(),
      path: 'notes/quarterly',
      kind: 'markdown',
    })
    const doc = new Loro()
    writeMarkdownBody(doc, 'Nothing relevant here.')
    writeCoreFacets(doc, { type: 'note', description: 'Quarterly zebracrossing summary' })
    await seedWorkspaceDocumentContent(entry.documentId, doc.export({ mode: 'snapshot' }))
    const source = createBrowserFilesSource({ index })

    const hits = await source.searchDocuments('zebracrossing')
    expect(hits.map((hit) => hit.document.path)).toEqual(['notes/quarterly'])
  })

  // Each source caches its corpus per document against the content stamp, so
  // a reference another source's rename rewrote reaches this one's search
  // through that stamp alone. The clock is pinned so the two writes cannot
  // land in the same millisecond and stamp alike.
  it('searches the reference a rename in another source rewrote', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date('2026-09-01T00:00:00.000Z'))
      const searching = createBrowserFilesSource()
      const renaming = createBrowserFilesSource()
      await searching.createDocument('design/login', 'markdown')
      await searching.createDocument('notes', 'markdown')
      const notes = (await searching.listDocuments()).find((entry) => entry.path === 'notes')
      const doc = new Loro()
      writeMarkdownBody(doc, 'see [[design/login]] for the flow')
      expect(
        await seedWorkspaceDocumentContent(
          notes?.documentId ?? '',
          doc.export({ mode: 'snapshot' }),
        ),
      ).toBe(true)
      const paths = async (query: string) =>
        (await searching.searchDocuments(query)).map((hit) => hit.document.path)
      // Searched once first, so the old body is what the corpus holds.
      expect(await paths('flow')).toEqual(['notes'])

      vi.setSystemTime(new Date('2026-09-01T00:00:01.000Z'))
      await renaming.renameDocumentPath('design/login', 'archive/login')

      expect(await paths('archive')).toContain('notes')
    } finally {
      vi.useRealTimers()
    }
  })
})

// ADR-0040: a board's own tags are the document's, listed like a note's, and
// what its boxes and edges carry is counted in the workspace's vocabulary —
// the browser keeper's spelling of the daemon's /document-tags.
describe('createBrowserFilesSource board tags and the vocabulary in use', () => {
  beforeEach(clearWhiteboardDb)

  it('lists a board’s own tags on its entry and counts every bearer in listTagsInUse', async () => {
    const note = await seedLegacyRow({
      workspaceId: getBrowserWorkspaceId(),
      path: 'note',
      kind: 'markdown',
    })
    const board = await seedLegacyRow({
      workspaceId: getBrowserWorkspaceId(),
      path: 'board',
      kind: 'spatial',
    })
    const store = new LoroStore()
    const noteDoc = new Loro()
    writeCoreFacets(noteDoc, { type: 'note', tags: ['q3'] })
    await store.save(note.documentId, noteDoc.export({ mode: 'snapshot' }))
    const boardDoc = new Loro()
    writeSpatialCanvas(boardDoc, {
      tags: ['team:core', 'q3'],
      nodes: [
        textNode({ id: 'a', x: 0, y: 0, width: 100, height: 50, text: 'a', tags: ['health:ok'] }),
        textNode({ id: 'b', x: 200, y: 0, width: 100, height: 50, text: 'b', tags: ['health:ok'] }),
      ],
      edges: [{ id: 'e', from: { node: 'a' }, to: { node: 'b' }, tags: ['link:slow'] }],
    })
    await store.save(board.documentId, boardDoc.export({ mode: 'snapshot' }))

    const source = createBrowserFilesSource()
    const entries = await source.listDocuments()
    expect(entries.find((e) => e.path === 'board')?.tags).toEqual(['team:core', 'q3'])
    // What the boxes and the edge carry, once each, beside the board's own —
    // never on the note, which has nothing inside.
    expect(entries.find((e) => e.path === 'board')?.carriedTags).toEqual(['health:ok', 'link:slow'])
    expect(entries.find((e) => e.path === 'note')?.carriedTags).toBeUndefined()
    expect(await source.listTagsInUse?.()).toEqual([
      { tag: 'health:ok', key: 'health', value: 'ok', documents: 0, boards: 0, nodes: 2, edges: 0 },
      { tag: 'link:slow', key: 'link', value: 'slow', documents: 0, boards: 0, nodes: 0, edges: 1 },
      { tag: 'q3', documents: 1, boards: 1, nodes: 0, edges: 0 },
      { tag: 'team:core', key: 'team', value: 'core', documents: 0, boards: 1, nodes: 0, edges: 0 },
    ])
  })

  it('reads the tag library the document at the tag library path declares, and answers none without one', async () => {
    await new IdbDocumentIndex().createWorkspace({ workspaceId: getBrowserWorkspaceId() })
    const store = new LoroStore()
    const before = createBrowserFilesSource()
    await expect(before.readTagLibrary?.()).resolves.toEqual({})
    const library = await seedLegacyRow({
      workspaceId: getBrowserWorkspaceId(),
      path: TAG_LIBRARY_PATH,
      kind: 'markdown',
    })
    const doc = new Loro()
    writeFacets(doc, {
      'visual.tags/v0': { keys: { health: { exclusive: true, values: { ok: { color: '4' } } } } },
    } as never)
    await store.save(library.documentId, doc.export({ mode: 'snapshot' }))
    const source = createBrowserFilesSource()
    await expect(source.readTagLibrary?.()).resolves.toEqual({
      health: { exclusive: true, values: { ok: { color: '4' } } },
    })
  })

  it('reads the stencil library the document at the stencil library path declares, and answers none without one', async () => {
    await new IdbDocumentIndex().createWorkspace({ workspaceId: getBrowserWorkspaceId() })
    const store = new LoroStore()
    await expect(createBrowserFilesSource().readStencilLibrary?.()).resolves.toEqual({})
    const library = await seedLegacyRow({
      workspaceId: getBrowserWorkspaceId(),
      path: STENCIL_LIBRARY_PATH,
      kind: 'markdown',
    })
    const doc = new Loro()
    writeFacets(doc, {
      'visual.stencils/v0': { stencils: { lakehouse: { displayName: 'Lakehouse', color: '3' } } },
    } as never)
    await store.save(library.documentId, doc.export({ mode: 'snapshot' }))
    await expect(createBrowserFilesSource().readStencilLibrary?.()).resolves.toEqual({
      lakehouse: { displayName: 'Lakehouse', color: '3', facets: {} },
    })
  })

  it('reads a library document whose stored bytes cannot be decoded as no library, not as a failure', async () => {
    const store = new LoroStore()
    for (const path of [TAG_LIBRARY_PATH, STENCIL_LIBRARY_PATH]) {
      const entry = await seedLegacyRow({
        workspaceId: getBrowserWorkspaceId(),
        path,
        kind: 'markdown',
      })
      await store.save(entry.documentId, new Uint8Array([1, 2, 3, 4]))
    }
    const source = createBrowserFilesSource()
    await expect(source.readTagLibrary?.()).resolves.toEqual({})
    await expect(source.readStencilLibrary?.()).resolves.toEqual({})
    await expectLoggedFailure('startup fold left documents behind')
  })
})

describe('createBrowserFilesSource tag cache', () => {
  beforeEach(clearWhiteboardDb)

  /**
   * Two tagged notes over an index with no workspace tree behind it, so every
   * content read falls through to the per-document store — and through the
   * counting one this hands the source.
   */
  async function twoTaggedNotes() {
    const index = new InMemoryDocumentIndex()
    await ensureBrowserWorkspace(index)
    const real = new LoroStore()
    const loads: string[] = []
    const loro = {
      save: (id: string, snapshot: Uint8Array) => real.save(id, snapshot),
      createEmptySnapshot: () => real.createEmptySnapshot(),
      load: (id: string) => {
        loads.push(id)
        return real.load(id)
      },
    }
    const ids: Record<string, string> = {}
    for (const path of ['one', 'two']) {
      const entry = await index.createDocument({
        workspaceId: getBrowserWorkspaceId(),
        path,
        kind: 'markdown',
      })
      ids[path] = entry.documentId
    }
    const write = async (path: string, tags: string[]) => {
      const doc = new Loro()
      writeCoreFacets(doc, { type: 'note', tags })
      await real.save(ids[path] as string, doc.export({ mode: 'snapshot' }))
    }
    await write('one', ['q3'])
    await write('two', ['q4'])
    const stamps = new Map([
      [ids.one as string, 'stamp-1'],
      [ids.two as string, 'stamp-1'],
    ])
    const source = createBrowserFilesSource({ index, loro, clock: async () => new Map(stamps) })
    return { source, loads, ids, stamps, write }
  }

  it('loads each document once, then none while their stamps stand still', async () => {
    const { source, loads } = await twoTaggedNotes()
    const first = await source.listDocuments()
    expect(first.map((entry) => entry.tags)).toEqual([['q3'], ['q4']])
    // The subject is present: the first listing really did read both.
    expect(loads).toHaveLength(2)

    loads.length = 0
    const second = await source.listDocuments()
    expect(second.map((entry) => entry.tags)).toEqual([['q3'], ['q4']])
    await source.listTagsInUse?.()
    expect(loads).toEqual([])
  })

  it('reads again only the document whose stamp moved', async () => {
    const { source, loads, ids, stamps, write } = await twoTaggedNotes()
    await source.listDocuments()

    await write('two', ['q4', 'urgent'])
    stamps.set(ids.two as string, 'stamp-2')
    loads.length = 0
    const entries = await source.listDocuments()

    expect(loads).toEqual([ids.two])
    expect(entries.find((entry) => entry.path === 'two')?.tags).toEqual(['q4', 'urgent'])
    expect(entries.find((entry) => entry.path === 'one')?.tags).toEqual(['q3'])
  })

  it('never holds a document that has no stamp, since nothing says when it changed', async () => {
    const { source, loads, ids, stamps } = await twoTaggedNotes()
    stamps.delete(ids.one as string)
    await source.listDocuments()
    loads.length = 0
    await source.listDocuments()
    expect(loads).toEqual([ids.one])
  })

  it('reads a document again when its row names a different kind, though its stamp stands', async () => {
    // A document that records no kind is whatever its row says, so what it
    // bears depends on the row as well as on the content.
    const rowKind: { value: DocumentKind } = { value: 'spatial' }
    const index = new (class extends InMemoryDocumentIndex {
      override async listDocuments(input: ListDocumentsInput): Promise<DocumentEntry[]> {
        return (await super.listDocuments(input)).map((row) => ({ ...row, kind: rowKind.value }))
      }
    })()
    await ensureBrowserWorkspace(index)
    const entry = await index.createDocument({
      workspaceId: getBrowserWorkspaceId(),
      path: 'shape-shifter',
      kind: 'spatial',
    })
    const store = new LoroStore()
    const doc = new Loro()
    writeSpatialCanvas(doc, {
      nodes: [
        textNode({ id: 'a', x: 0, y: 0, width: 10, height: 10, text: 'a', tags: ['health:ok'] }),
      ],
      edges: [],
    })
    await store.save(entry.documentId, doc.export({ mode: 'snapshot' }))
    const source = createBrowserFilesSource({
      index,
      clock: async () => new Map([[entry.documentId, 'stamp-1']]),
    })

    expect((await source.listDocuments())[0]?.carriedTags).toEqual(['health:ok'])
    rowKind.value = 'markdown'
    expect((await source.listDocuments())[0]?.carriedTags).toBeUndefined()
  })

  it('counts the vocabulary in use from what the listing already read', async () => {
    const { source, loads } = await twoTaggedNotes()
    await source.listDocuments()
    loads.length = 0
    expect((await source.listTagsInUse?.())?.map((row) => row.tag)).toEqual(['q3', 'q4'])
    expect(loads).toEqual([])
  })
})

describe('createBrowserFilesSource over a row that names no kind', () => {
  beforeEach(clearWhiteboardDb)

  it('reads it as a canvas — its carried tags are listed and its text is searched', async () => {
    // The row of a document written before kinds existed. Whatever the content
    // holds, `readDocumentContent` says what such a document is, and every walk
    // in the source has to agree with it rather than each choosing its own.
    const index = new FoldingBrowserIndex()
    await ensureBrowserWorkspace(index)
    const entry = await index.createDocument({
      workspaceId: getBrowserWorkspaceId(),
      path: 'pre-kind',
      kind: 'spatial',
    })
    const doc = new Loro()
    writeSpatialCanvas(doc, {
      nodes: [
        textNode({
          id: 'a',
          x: 0,
          y: 0,
          width: 100,
          height: 50,
          text: 'first',
          tags: ['health:ok'],
        }),
        // A markdown read of this document takes only the first text node.
        textNode({ id: 'b', x: 200, y: 0, width: 100, height: 50, text: 'findable' }),
      ],
      edges: [],
    })
    await seedWorkspaceDocumentContent(entry.documentId, doc.export({ mode: 'snapshot' }))
    const kindless = Object.create(index, {
      listDocuments: {
        value: async (input: Parameters<typeof index.listDocuments>[0]) =>
          (await index.listDocuments(input)).map(({ kind: _kind, ...row }) => row),
      },
    }) as FoldingBrowserIndex
    const source = createBrowserFilesSource({ index: kindless })

    const [listed] = await source.listDocuments()
    expect(listed?.kind).toBeUndefined()
    expect(listed?.carriedTags).toEqual(['health:ok'])
    expect((await source.searchDocuments('findable')).map((hit) => hit.document.path)).toEqual([
      'pre-kind',
    ])
  })
})

function boardOf(document: {
  tags?: readonly string[]
  nodeTags?: readonly (readonly string[])[]
  edgeTags?: readonly (readonly string[])[]
}): SpatialCanvas {
  const nodes = (document.nodeTags ?? []).map((tags, i) =>
    textNode({
      id: `n${i}`,
      x: i * 200,
      y: 0,
      width: 100,
      height: 50,
      text: `n${i}`,
      tags: [...tags],
    }),
  )
  return {
    ...(document.tags === undefined ? {} : { tags: [...document.tags] }),
    nodes,
    edges: (document.edgeTags ?? []).map((tags, i) => ({
      id: `e${i}`,
      from: { node: 'n0' },
      to: { node: 'n1' },
      tags: [...tags],
    })),
  }
}

describe('createBrowserFilesSource conformance', () => {
  beforeEach(clearWhiteboardDb)

  describeWorkspaceFilesSourceConformance('createBrowserFilesSource', async (fixture) => {
    const index = new FoldingBrowserIndex()
    await ensureBrowserWorkspace(index)
    const workspaceId = getBrowserWorkspaceId()
    for (const document of fixture.documents ?? []) {
      const entry = await index.createDocument({
        workspaceId,
        path: document.path,
        kind: document.kind,
        ...(document.name === undefined ? {} : { name: document.name }),
      })
      const doc = new Loro()
      if (document.body !== undefined) writeMarkdownBody(doc, document.body)
      if (document.kind === 'spatial') {
        writeSpatialCanvas(doc, boardOf(document))
      } else if (document.tags !== undefined) {
        writeCoreFacets(doc, { type: 'note', tags: [...document.tags] })
      }
      if (document.facets !== undefined) writeFacets(doc, document.facets as never)
      await seedWorkspaceDocumentContent(entry.documentId, doc.export({ mode: 'snapshot' }))
    }
    for (const gone of fixture.trashed ?? []) {
      const entry = await index.createDocument({ workspaceId, path: gone.path, kind: gone.kind })
      await seedWorkspaceDocumentContent(entry.documentId, new Loro().export({ mode: 'snapshot' }))
      await index.deleteDocument({ workspaceId, path: gone.path })
    }
    return createBrowserFilesSource({ index })
  })
})
