/**
 * The synchronous accessor + async resolver for the browser's own workspace
 * id — the canonical ULID a v14+ database keys its `workspaces` row under.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BROWSER_DEFAULT_SEGMENT, setWhiteboardDbNameForTests } from './browser-idb.js'
import {
  browserWorkspaceHandleOrNull,
  getBrowserWorkspaceId,
  getBrowserWorkspaceIdentity,
  resetBrowserWorkspaceIdForTests,
  resolveBrowserWorkspaceId,
  setBrowserWorkspaceIdForTests,
} from './browser-workspace-id.js'
import { IdbDocumentIndex } from './idb-document-index.js'

const DB_NAME = 'whiteboard-workspace-id-test'

// Fixed rather than minted: two ULIDs created inside one millisecond order
// randomly, so a test that mints them asserts a coincidence — and passes
// alone while failing under a full parallel run, which is the worst way to
// learn it. These two differ in the timestamp half.
const EARLIER_ULID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const LATER_ULID = '01BX5ZZKBKACTAV9WEVGEMMVRZ'

async function clearDb(): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME)
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
  })
}

describe('browser workspace id accessor', () => {
  beforeEach(async () => {
    resetBrowserWorkspaceIdForTests()
    setWhiteboardDbNameForTests(DB_NAME)
    await clearDb()
  })
  afterEach(async () => {
    resetBrowserWorkspaceIdForTests()
    await clearDb()
  })

  it('throws an actionable message before resolveBrowserWorkspaceId() has completed', () => {
    expect(() => getBrowserWorkspaceId()).toThrow(/resolveBrowserWorkspaceId/)
  })

  it('returns the canonical ULID once resolved, matching documentIdSchema', async () => {
    const id = await resolveBrowserWorkspaceId(DB_NAME)
    expect(id).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/)
    expect(getBrowserWorkspaceId()).toBe(id)
  })

  it('is idempotent: a second resolve reuses the cached id without reopening', async () => {
    const first = await resolveBrowserWorkspaceId(DB_NAME)
    const second = await resolveBrowserWorkspaceId(DB_NAME)
    expect(second).toBe(first)
  })

  it('the test seam sets a resolved value directly, without opening a database', () => {
    setBrowserWorkspaceIdForTests('01ARZ3NDEKTSV4RRFFQ69G5FAV')
    expect(getBrowserWorkspaceId()).toBe('01ARZ3NDEKTSV4RRFFQ69G5FAV')
  })

  it('resolves the whole identity, so an address can name this workspace', async () => {
    // The id alone was enough while the browser had no addressable name. It
    // is not enough to BUILD an address: ADR-0019 puts the segment in the
    // URL, and reading the registry row's key gives only the fallback form.
    const id = await resolveBrowserWorkspaceId(DB_NAME)
    expect(getBrowserWorkspaceIdentity()).toEqual({
      workspaceId: id,
      segment: BROWSER_DEFAULT_SEGMENT,
    })
  })

  it('the identity accessor throws the same actionable message when unresolved', () => {
    expect(() => getBrowserWorkspaceIdentity()).toThrow(/resolveBrowserWorkspaceId/)
  })

  it('the test seam can set a segment, since callers now address by one', () => {
    setBrowserWorkspaceIdForTests('01ARZ3NDEKTSV4RRFFQ69G5FAV', 'design-team')
    expect(getBrowserWorkspaceIdentity()).toEqual({
      workspaceId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      segment: 'design-team',
    })
    // The id accessor is unchanged — every existing caller reads through it.
    expect(getBrowserWorkspaceId()).toBe('01ARZ3NDEKTSV4RRFFQ69G5FAV')
  })

  it('a second workspace does not break the resolve', async () => {
    // The blocker this slice exists to remove: the resolver asserted the
    // registry held EXACTLY one row and rejected otherwise, so creating a
    // second browser workspace did not degrade anything — it stopped the app
    // from booting at all. Not resolving to a PARTICULAR one here: which one
    // an address-less resolve picks is the next case's subject, and asserting
    // it from a minted id would be asserting a ULID-ordering coincidence.
    const first = await resolveBrowserWorkspaceId(DB_NAME)
    await new IdbDocumentIndex(DB_NAME).createWorkspace({
      workspaceId: LATER_ULID,
      segment: 'second',
    })

    resetBrowserWorkspaceIdForTests()
    await expect(resolveBrowserWorkspaceId(DB_NAME)).resolves.toEqual(
      expect.stringMatching(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/),
    )
    expect([first, LATER_ULID]).toContain(getBrowserWorkspaceId())
  })

  it('an address-less resolve takes the oldest workspace, by id order', async () => {
    // The chain's last rung. A canonical id is a ULID, so id order IS
    // creation order at any timescale a person creates workspaces on —
    // within ONE millisecond two ULIDs order randomly, which is why this
    // fixes both ids rather than minting them.
    await new IdbDocumentIndex(DB_NAME).createWorkspace({
      workspaceId: LATER_ULID,
      segment: 'later',
    })
    await new IdbDocumentIndex(DB_NAME).createWorkspace({
      workspaceId: EARLIER_ULID,
      segment: 'earlier',
    })

    resetBrowserWorkspaceIdForTests()
    expect(await resolveBrowserWorkspaceId(DB_NAME)).toBe(EARLIER_ULID)
  })

  it('resolves the workspace the address names, not merely the first row', async () => {
    // Which one is ACTIVE is the address's to say (ADR-0019). Without the
    // handle the resolver can only pick, and picking is what made a switch
    // invisible to everything downstream.
    await resolveBrowserWorkspaceId(DB_NAME)
    await new IdbDocumentIndex(DB_NAME).createWorkspace({
      workspaceId: LATER_ULID,
      segment: 'second',
    })

    resetBrowserWorkspaceIdForTests()
    expect(await resolveBrowserWorkspaceId(DB_NAME, 'second')).toBe(LATER_ULID)
    expect(getBrowserWorkspaceIdentity()).toEqual({ workspaceId: LATER_ULID, segment: 'second' })
  })

  it('falls back to the sole workspace when the address names one it does not have', async () => {
    // A stale bookmark, or a hand-typed handle. Answering the workspace that
    // exists beats refusing to boot; the ROUTE layer is where a name nothing
    // matches becomes not-found, with a page to say so.
    const only = await resolveBrowserWorkspaceId(DB_NAME)
    resetBrowserWorkspaceIdForTests()
    expect(await resolveBrowserWorkspaceId(DB_NAME, 'no-such-workspace')).toBe(only)
  })

  it('the handle is the segment when there is one, the id when there is not', () => {
    // What an ADDRESS carries. Both arms are live: a v15+ registry row has a
    // segment, and a row written before that carrier does not.
    setBrowserWorkspaceIdForTests('01ARZ3NDEKTSV4RRFFQ69G5FAV', 'design-team')
    expect(browserWorkspaceHandleOrNull()).toBe('design-team')

    setBrowserWorkspaceIdForTests('01ARZ3NDEKTSV4RRFFQ69G5FAV')
    expect(browserWorkspaceHandleOrNull()).toBe('01ARZ3NDEKTSV4RRFFQ69G5FAV')
  })

  it('the handle is null, not a throw, while the workspace is unavailable', () => {
    // boot.ts deliberately does not gate on the IndexedDB open, so a render
    // can reach a URL builder before the identity resolves — or after it
    // failed. A throw in an argument position escapes the caller's own catch;
    // a null lets it decline to navigate, which is what every URL builder
    // here does with an address it cannot name.
    expect(browserWorkspaceHandleOrNull()).toBeNull()
  })

  it('a workspace with no segment resolves to an identity carrying none', () => {
    // Not hypothetical: the seam's one-argument form is what most tests use,
    // and a row written before v15 has no segment either. An identity that
    // invented one here would make every such caller address a workspace by
    // a name its registry does not hold.
    setBrowserWorkspaceIdForTests('01ARZ3NDEKTSV4RRFFQ69G5FAV')
    expect(getBrowserWorkspaceIdentity()).toEqual({
      workspaceId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    })
  })
})
