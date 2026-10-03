/**
 * What every keeper's `WorkspaceFilesSource` answers the same way.
 *
 * The browser keeper reads its own stores and the daemon keeper reads HTTP
 * answers, so each unit-tests itself against its own doubles and nothing said
 * the two agree. This states what the panel may rely on whichever one it was
 * handed, over ONE fixture the caller materialises through the keeper's own
 * path — the way `describeDocumentIndexConformance` does for the index port.
 */
import type { DocumentKind } from '@kamiazya/whiteboard-model'
import { STENCIL_LIBRARY_PATH, TAG_LIBRARY_PATH } from '@kamiazya/whiteboard-plugin-visual'
import { describe, expect, it } from 'vitest'
import type { WorkspaceFilesSource } from '../lib/files-source.js'

interface FilesSourceFixtureDocument {
  readonly path: string
  readonly kind: DocumentKind
  readonly name?: string
  readonly body?: string
  readonly tags?: readonly string[]
  /** Extension facets stored beside the body; a library is the document at `TAG_LIBRARY_PATH` / `STENCIL_LIBRARY_PATH`. */
  readonly facets?: Record<string, unknown>
}

interface FilesSourceFixture {
  readonly documents?: readonly FilesSourceFixtureDocument[]
  /** Documents already deleted, so they sit in the trash. */
  readonly trashed?: readonly { readonly path: string; readonly kind: DocumentKind }[]
}

export type FilesSourceFactory = (fixture: FilesSourceFixture) => Promise<WorkspaceFilesSource>

const TAG_LIBRARY = {
  // Declared out of name order on purpose: both keepers answer by name.
  zone: { values: { b: { color: '2' }, a: {} } },
  health: { exclusive: true, values: { ok: { color: '4' } } },
}

const libraryFixture = (
  path: typeof TAG_LIBRARY_PATH | typeof STENCIL_LIBRARY_PATH,
  facets: Record<string, unknown>,
): FilesSourceFixture => ({ documents: [{ path, kind: 'markdown', facets }] })

const summary = (entries: readonly { path: string; kind?: string; name?: string }[]) =>
  entries
    .map(({ path, kind, name }) => ({ path, kind, name }))
    .sort((a, b) => (a.path < b.path ? -1 : 1))

function listingContract(factory: FilesSourceFactory): void {
  it('lists an empty workspace as empty', async () => {
    const source = await factory({})
    await expect(source.listDocuments()).resolves.toEqual([])
  })

  it('lists each document with path, kind and name, under an id that survives a re-list', async () => {
    const source = await factory({
      documents: [
        { path: 'notes/plan', kind: 'markdown', name: 'Plan' },
        { path: 'board', kind: 'spatial' },
      ],
    })
    const first = await source.listDocuments()
    expect(summary(first)).toEqual([
      { path: 'board', kind: 'spatial', name: undefined },
      { path: 'notes/plan', kind: 'markdown', name: 'Plan' },
    ])
    const ids = first.map((entry) => entry.documentId)
    expect(new Set(ids).size).toBe(2)
    expect(ids.every((id) => id.length > 0)).toBe(true)
    expect(
      (await source.listDocuments()).map((entry) => [entry.path, entry.documentId]).sort(),
    ).toEqual(first.map((entry) => [entry.path, entry.documentId]).sort())
  })
}

function tagReadContract(factory: FilesSourceFactory): void {
  it('lists the tags a document carries on its own row', async () => {
    const source = await factory({
      documents: [
        { path: 'tagged', kind: 'markdown', tags: ['q3', 'team:core'] },
        { path: 'plain', kind: 'markdown' },
      ],
    })
    const entries = await source.listDocuments()
    expect(entries.find((entry) => entry.path === 'tagged')?.tags).toEqual(['q3', 'team:core'])
    expect(entries.find((entry) => entry.path === 'plain')?.tags ?? []).toEqual([])
  })

  it('counts a note tag once under documents in the vocabulary in use', async () => {
    const source = await factory({
      documents: [{ path: 'tagged', kind: 'markdown', tags: ['q3'] }],
    })
    expect(source.listTagsInUse).toBeDefined()
    await expect(source.listTagsInUse?.()).resolves.toEqual([
      { tag: 'q3', documents: 1, boards: 0, nodes: 0, edges: 0 },
    ])
  })

  it('answers the BODY of a markdown document, never its frontmatter', async () => {
    const source = await factory({
      documents: [{ path: 'note', kind: 'markdown', body: 'hello world', tags: ['q3'] }],
    })
    const [entry] = await source.listDocuments()
    expect((await source.loadMarkdown(entry as never)).body).toBe('hello world')
  })

  it('answers the extension facets stored beside the body', async () => {
    const facets = { 'visual.mark/v0': { icon: 'star' } }
    const source = await factory({
      documents: [{ path: 'note', kind: 'markdown', body: 'x', facets }],
    })
    const [entry] = await source.listDocuments()
    expect((await source.loadMarkdown(entry as never)).facets).toEqual(facets)
  })
}

function writeContract(factory: FilesSourceFactory): void {
  it('creates a document that lists with its kind and name', async () => {
    const source = await factory({})
    await source.createDocument('fresh', 'markdown', 'Fresh')
    expect(summary(await source.listDocuments())).toEqual([
      { path: 'fresh', kind: 'markdown', name: 'Fresh' },
    ])
  })

  it('moves a document and everything under it on rename, keeping their ids', async () => {
    const source = await factory({
      documents: [
        { path: 'plan', kind: 'markdown' },
        { path: 'plan/sub', kind: 'markdown' },
      ],
    })
    const before = await source.listDocuments()
    await source.renameDocumentPath('plan', 'roadmap')
    const after = await source.listDocuments()
    expect(after.map((entry) => entry.path).sort()).toEqual(['roadmap', 'roadmap/sub'])
    const idOf = (entries: typeof after, path: string) =>
      entries.find((entry) => entry.path === path)?.documentId
    expect(idOf(after, 'roadmap')).toBe(idOf(before, 'plan'))
    expect(idOf(after, 'roadmap/sub')).toBe(idOf(before, 'plan/sub'))
  })

  it('sets a name and clears it again by passing undefined', async () => {
    const source = await factory({ documents: [{ path: 'doc', kind: 'markdown' }] })
    const [entry] = await source.listDocuments()
    const target = { documentId: entry?.documentId ?? '', path: 'doc' }
    await source.setDocumentName(target, 'Named')
    expect((await source.listDocuments())[0]?.name).toBe('Named')
    await source.setDocumentName(target, undefined)
    expect((await source.listDocuments())[0]?.name).toBeUndefined()
  })

  it('answers nothing to an empty or blank search', async () => {
    const source = await factory({
      documents: [{ path: 'note', kind: 'markdown', body: 'needle' }],
    })
    await expect(source.searchDocuments('')).resolves.toEqual([])
    await expect(source.searchDocuments('   ')).resolves.toEqual([])
  })
}

function tagLibraryContract(factory: FilesSourceFactory): void {
  describe('tag library', () => {
    it('is empty when no document sits at the tag library path', async () => {
      const source = await factory({})
      expect(source.readTagLibrary).toBeDefined()
      await expect(source.readTagLibrary?.()).resolves.toEqual({})
    })

    it('is what the document at the tag library path declares, read by name', async () => {
      const source = await factory(
        libraryFixture(TAG_LIBRARY_PATH, { 'visual.tags/v0': { keys: TAG_LIBRARY } }),
      )
      const library = await source.readTagLibrary?.()
      expect(library).toEqual(TAG_LIBRARY)
      expect(Object.keys(library ?? {})).toEqual(['health', 'zone'])
      expect(Object.keys(library?.zone?.values ?? {})).toEqual(['a', 'b'])
    })

    it('is empty when the document at the tag library path holds a payload the schema refuses', async () => {
      const source = await factory(
        libraryFixture(TAG_LIBRARY_PATH, { 'visual.tags/v0': { keys: 5 } }),
      )
      await expect(source.readTagLibrary?.()).resolves.toEqual({})
    })

    it('is empty when the document at the tag library path carries no library facet', async () => {
      const source = await factory(
        libraryFixture(TAG_LIBRARY_PATH, { 'visual.mark/v0': { icon: 'star' } }),
      )
      await expect(source.readTagLibrary?.()).resolves.toEqual({})
    })
  })
}

function stencilLibraryContract(factory: FilesSourceFactory): void {
  describe('stencil library', () => {
    const STENCILS = { lakehouse: { displayName: 'Lakehouse', color: '3' } }

    it('is empty when no document sits at the stencil library path', async () => {
      const source = await factory({})
      expect(source.readStencilLibrary).toBeDefined()
      await expect(source.readStencilLibrary?.()).resolves.toEqual({})
    })

    it('is what the document at the stencil library path declares, each stencil with its facets defaulted', async () => {
      const source = await factory(
        libraryFixture(STENCIL_LIBRARY_PATH, { 'visual.stencils/v0': { stencils: STENCILS } }),
      )
      await expect(source.readStencilLibrary?.()).resolves.toEqual({
        lakehouse: { ...STENCILS.lakehouse, facets: {} },
      })
    })

    it('is empty when the document at the stencil library path holds a payload the schema refuses', async () => {
      const source = await factory(
        libraryFixture(STENCIL_LIBRARY_PATH, { 'visual.stencils/v0': { stencils: 5 } }),
      )
      await expect(source.readStencilLibrary?.()).resolves.toEqual({})
    })

    it('does not read a tag library as a stencil library', async () => {
      const source = await factory(
        libraryFixture(TAG_LIBRARY_PATH, { 'visual.tags/v0': { keys: TAG_LIBRARY } }),
      )
      await expect(source.readStencilLibrary?.()).resolves.toEqual({})
    })
  })
}

function trashContract(factory: FilesSourceFactory): void {
  describe('trash', () => {
    const trashed = { trashed: [{ path: 'old/plan', kind: 'markdown' as const }] }

    it('lists what was deleted with its path and a deletion time', async () => {
      const source = await factory(trashed)
      const rows = await source.listTrash?.()
      expect(rows).toHaveLength(1)
      expect(rows?.[0]?.path).toBe('old/plan')
      expect(rows?.[0]?.documentId.length).toBeGreaterThan(0)
      expect(typeof rows?.[0]?.deletedAt).toBe('number')
    })

    it('restores a trashed document under the SAME documentId', async () => {
      const source = await factory(trashed)
      const [row] = (await source.listTrash?.()) ?? []
      await source.restoreFromTrash?.(row?.documentId ?? '')
      const restored = (await source.listDocuments()).find((entry) => entry.path === 'old/plan')
      expect(restored?.documentId).toBe(row?.documentId)
    })

    it('refuses to restore a document that is not in the trash', async () => {
      const source = await factory(trashed)
      await expect(source.restoreFromTrash?.('never-existed')).rejects.toThrow()
    })
  })
}

export function describeWorkspaceFilesSourceConformance(
  name: string,
  factory: FilesSourceFactory,
): void {
  describe(`${name} satisfies WorkspaceFilesSource`, () => {
    listingContract(factory)
    tagReadContract(factory)
    writeContract(factory)
    tagLibraryContract(factory)
    stencilLibraryContract(factory)
    trashContract(factory)
  })
}
