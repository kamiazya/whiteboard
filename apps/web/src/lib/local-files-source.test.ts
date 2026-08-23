/**
 * The browser's `WorkspaceFilesSource` — the adapter that lets the
 * three-pane browser serve local mode, which is the whole point of the seam.
 */
import 'fake-indexeddb/auto'
import { writeCoreFacets } from '@kamiazya/whiteboard-loro-adapter'
import { Loro } from 'loro-crdt'
import { beforeEach, describe, expect, it } from 'vitest'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { IdbDocumentIndex } from './idb-document-index.js'
import { ensureLocalWorkspace } from './local-document-summary.js'
import { createLocalFilesSource } from './local-files-source.js'
import { LoroStore } from './loro-store.js'

claimIsolatedWhiteboardDb('local-files-source')

describe('createLocalFilesSource', () => {
  beforeEach(clearWhiteboardDb)

  it('lists a fresh database as empty, not as missing', async () => {
    // Written as the missing-workspace case first, and the test refuted its
    // own premise: the v8+ IndexedDB upgrade seeds the `local` workspace row
    // unconditionally, so a fresh database HAS the workspace before anything
    // else touches it. The `WorkspaceMissingError` mapping in the source
    // stays — it guards a state a hand-edited store can still reach — but the
    // reachable first-run behaviour is an empty list.
    await expect(createLocalFilesSource().listDocuments()).resolves.toEqual([])
  })

  it('lists what the index holds', async () => {
    const index = new IdbDocumentIndex()
    await ensureLocalWorkspace(index)
    await index.createDocument({ workspaceId: 'local', path: 'a', kind: 'spatial', name: 'A' })

    const entries = await createLocalFilesSource().listDocuments()
    expect(entries.map((e) => ({ path: e.path, name: e.name, kind: e.kind }))).toEqual([
      { path: 'a', name: 'A', kind: 'spatial' },
    ])
  })

  it('creates a document with seeded content, like every other local create', async () => {
    const source = createLocalFilesSource()
    const index = new IdbDocumentIndex()
    await ensureLocalWorkspace(index)

    await source.createDocument('notes/plan', 'markdown')

    const entries = await source.listDocuments()
    expect(entries.map((e) => e.path)).toEqual(['notes/plan'])
    // Content record seeded: a document created without one has no
    // last-edited time and nothing to open.
    const loaded = await new LoroStore().load(entries[0]?.documentId ?? '')
    expect(loaded.kind).toBe('ok')
  })

  it('renames through the index, so the subtree moves with it', async () => {
    const source = createLocalFilesSource()
    const index = new IdbDocumentIndex()
    await ensureLocalWorkspace(index)
    await index.createDocument({ workspaceId: 'local', path: 'plan', kind: 'markdown' })
    await index.createDocument({ workspaceId: 'local', path: 'plan/sub', kind: 'markdown' })

    await source.renameDocumentPath('plan', 'roadmap')

    const paths = (await source.listDocuments()).map((e) => e.path).sort()
    expect(paths).toEqual(['roadmap', 'roadmap/sub'])
  })

  it('names a document by its ID, and clears the name by absence', async () => {
    // The daemon sibling keys the same call on PATH; both are plain strings,
    // so a swap typechecks and silently renames nothing. The fixture makes
    // the two addresses differ (a nested path never equals an id) so only
    // the id can produce this result.
    const source = createLocalFilesSource()
    const index = new IdbDocumentIndex()
    await ensureLocalWorkspace(index)
    const created = await index.createDocument({
      workspaceId: 'local',
      path: 'plans/roadmap',
      kind: 'markdown',
    })

    await source.setDocumentName({ documentId: created.documentId, path: created.path }, 'Roadmap')
    expect((await source.listDocuments())[0]?.name).toBe('Roadmap')

    // Clearing is ABSENCE for the port (the daemon spells it as an empty
    // string) — a reader then falls back to the path's last segment.
    await source.setDocumentName({ documentId: created.documentId, path: created.path }, undefined)
    expect((await source.listDocuments())[0]?.name).toBeUndefined()
  })

  it('reads a markdown document body back', async () => {
    const source = createLocalFilesSource()
    const index = new IdbDocumentIndex()
    await ensureLocalWorkspace(index)
    const entry = await index.createDocument({ workspaceId: 'local', path: 'n', kind: 'markdown' })
    const doc = new Loro()
    doc.getText('body').insert(0, '# Hello from local')
    await new LoroStore().save(entry.documentId, doc.export({ mode: 'snapshot' }))

    const markdown = await source.loadMarkdown({ ...entry, kind: 'markdown' })
    expect(markdown).toContain('Hello from local')
  })

  it('answers the CURRENT spatial bytes, deltas folded in', async () => {
    const source = createLocalFilesSource()
    const index = new IdbDocumentIndex()
    await ensureLocalWorkspace(index)
    const entry = await index.createDocument({ workspaceId: 'local', path: 's', kind: 'spatial' })
    const doc = new Loro()
    doc.getList('elements').push({ id: 'a' })
    doc.commit()
    const store = new LoroStore()
    await store.save(entry.documentId, doc.export({ mode: 'snapshot' }))
    const before = doc.version()
    doc.getList('elements').push({ id: 'b' })
    doc.commit()
    await store.appendDelta(entry.documentId, doc.export({ mode: 'update', from: before }))

    const bytes = await source.loadSpatialSnapshot({ ...entry, kind: 'spatial' })
    const fresh = new Loro()
    fresh.import(bytes)
    // Both elements: a thumbnail of the last snapshot alone would show a
    // document the user is not looking at.
    expect(fresh.getList('elements').toJSON()).toHaveLength(2)
  })
})

describe('createLocalFilesSource tags', () => {
  beforeEach(clearWhiteboardDb)

  it('surfaces core-facet tags on markdown entries and omits them elsewhere', async () => {
    const index = new IdbDocumentIndex()
    await ensureLocalWorkspace(index)
    const tagged = await index.createDocument({
      workspaceId: 'local',
      path: 'tagged',
      kind: 'markdown',
    })
    await index.createDocument({ workspaceId: 'local', path: 'plain', kind: 'markdown' })

    const doc = new Loro()
    writeCoreFacets(doc, { type: 'note', tags: ['release', 'q3'] })
    await new LoroStore().save(tagged.documentId, doc.export({ mode: 'snapshot' }))

    const entries = await createLocalFilesSource().listDocuments()
    expect(entries.find((e) => e.path === 'tagged')?.tags).toEqual(['release', 'q3'])
    expect(entries.find((e) => e.path === 'plain')?.tags).toBeUndefined()
  })
})
