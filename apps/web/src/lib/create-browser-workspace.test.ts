/**
 * Creating a browser-kept workspace: who mints the id, where the segment
 * comes from, and what happens when it cannot come from anywhere.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setWhiteboardDbNameForTests } from './browser-idb.js'
import { createBrowserWorkspace } from './create-browser-workspace.js'
import { IdbDocumentIndex } from './idb-document-index.js'

const DB_NAME = 'whiteboard-create-workspace-test'

async function clearDb(): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME)
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
  })
}

describe('createBrowserWorkspace', () => {
  beforeEach(async () => {
    setWhiteboardDbNameForTests(DB_NAME)
    await clearDb()
  })
  afterEach(clearDb)

  it('mints a canonical id here, because the browser is its own keeper', async () => {
    // The daemon's create surface mints server-side (the MintBoundary). The
    // browser has no server in the loop, so the id is minted right here —
    // still a canonical ULID, because that is what every store keys on.
    const index = new IdbDocumentIndex(DB_NAME)
    const created = await createBrowserWorkspace(index, { displayName: 'Design Team' })

    expect(created.workspaceId).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/)
    expect(await index.resolveWorkspace(created.workspaceId)).not.toBeNull()
  })

  it('derives the segment from the display name', async () => {
    const index = new IdbDocumentIndex(DB_NAME)
    const created = await createBrowserWorkspace(index, { displayName: '  Design Team  ' })

    expect(created.segment).toBe('design-team')
    expect(created.displayName).toBe('Design Team')
    expect(await index.resolveWorkspace('design-team')).toEqual(created)
  })

  it('leaves the segment ABSENT when the name yields none, rather than inventing one', async () => {
    // A name in a script the segment charset cannot spell. ADR-0019 already
    // decided this shape: 0019's migration left a segment NULL rather than
    // writing a mangled approximation, and a workspace with no segment is
    // addressed by its canonical id — which is what that layer is for. An
    // invented `workspace-2` would be a name nobody chose, in the URL, for
    // as long as the workspace lives.
    const index = new IdbDocumentIndex(DB_NAME)
    const created = await createBrowserWorkspace(index, { displayName: '設計チーム' })

    expect(created.segment).toBeUndefined()
    expect(created.displayName).toBe('設計チーム')
    expect(await index.resolveWorkspace(created.workspaceId)).toEqual(created)
  })

  it('refuses to derive a ULID-shaped segment, which would be ambiguous', async () => {
    // One address position holds both layers, so a segment that looks like a
    // canonical id makes the two forms indistinguishable there.
    const index = new IdbDocumentIndex(DB_NAME)
    const created = await createBrowserWorkspace(index, {
      displayName: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    })

    expect(created.segment).toBeUndefined()
  })

  it('suffixes a derived segment that is already taken in this browser', async () => {
    // The display name may repeat — ADR-0019 gives it no uniqueness duty —
    // so a second "Design Team" must not be REFUSED. Only the address it
    // derives has to be unique, and only within this browser: the registry
    // is IndexedDB, which is per-client, so nothing here can collide with
    // another person's.
    const index = new IdbDocumentIndex(DB_NAME)
    await createBrowserWorkspace(index, { displayName: 'Design Team' })
    const second = await createBrowserWorkspace(index, { displayName: 'Design Team' })

    expect(second.segment).toBe('design-team-2')
    expect(second.displayName).toBe('Design Team')
    expect(await index.resolveWorkspace('design-team')).not.toEqual(second)
  })

  it('refuses a name that is only whitespace, rather than storing a nameless one', async () => {
    // Trimming is right for stray spaces; trimming to nothing is a different
    // case. A workspace with no name has nothing to show in a switcher, and
    // the form that collected it is where a person can still fix it.
    const index = new IdbDocumentIndex(DB_NAME)
    // Counted rather than compared against an empty list: opening the
    // database runs the migration chain, which mints this browser's own
    // workspace. The registry is never empty, and a test that expected it to
    // be would be asserting the absence of something that is always there.
    const before = (await index.listWorkspaces()).length
    await expect(createBrowserWorkspace(index, { displayName: '   ' })).rejects.toThrow(/name/)
    expect(await index.listWorkspaces()).toHaveLength(before)
  })

  it('keeps counting past the first suffix', async () => {
    const index = new IdbDocumentIndex(DB_NAME)
    await createBrowserWorkspace(index, { displayName: 'Notes' })
    await createBrowserWorkspace(index, { displayName: 'Notes' })
    const third = await createBrowserWorkspace(index, { displayName: 'Notes' })

    expect(third.segment).toBe('notes-3')
  })
})
