/**
 * The synchronous accessor + async resolver for the browser's own workspace
 * id — the canonical ULID a v14+ database keys its `workspaces` row under.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearNamedDb, registerTestWorkspace } from '../test-utils/browser-document.js'
import { expectLoggedFailure } from '../test-utils/logged-failures.js'
import {
  BROWSER_DEFAULT_SEGMENT,
  openWhiteboardDb,
  setWhiteboardDbNameForTests,
  WORKSPACES_STORE,
} from './browser-idb.js'
import {
  browserWorkspaceHandleOrNull,
  getBrowserWorkspaceId,
  getBrowserWorkspaceIdentity,
  leaveRemovedWorkspace,
  resetBrowserWorkspaceIdForTests,
  resolveBrowserWorkspaceId,
  setBrowserWorkspaceIdForTests,
  switchBrowserWorkspace,
} from './browser-workspace-id.js'
import { IdbDocumentIndex } from './idb-document-index.js'
import { request } from './idb-tx.js'

const DB_NAME = 'whiteboard-workspace-id-test'

// Fixed rather than minted: two ULIDs created inside one millisecond order
// randomly, so a test that mints them asserts a coincidence — and passes
// alone while failing under a full parallel run, which is the worst way to
// learn it. These two differ in the timestamp half.
const EARLIER_ULID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const LATER_ULID = '01BX5ZZKBKACTAV9WEVGEMMVRZ'

/** What a removal in another tab leaves: no registry row for the id. */
async function removeRow(workspaceId: string): Promise<void> {
  const db = await openWhiteboardDb(DB_NAME)
  try {
    await request(
      db
        .transaction([WORKSPACES_STORE], 'readwrite')
        .objectStore(WORKSPACES_STORE)
        .delete(workspaceId),
    )
  } finally {
    db.close()
  }
}

async function clearRows(): Promise<void> {
  const db = await openWhiteboardDb(DB_NAME)
  try {
    await request(
      db.transaction([WORKSPACES_STORE], 'readwrite').objectStore(WORKSPACES_STORE).clear(),
    )
  } finally {
    db.close()
  }
}

/**
 * Aborts the transaction of the registry's `getAll` from that request's own
 * success event, so the read's transaction never completes.
 */
function abortRegistryReadAfterAnswer(): void {
  const original = IDBObjectStore.prototype.getAll
  vi.spyOn(IDBObjectStore.prototype, 'getAll').mockImplementation(function (
    this: IDBObjectStore,
    ...args: Parameters<IDBObjectStore['getAll']>
  ) {
    const req = original.apply(this, args)
    if (this.name === WORKSPACES_STORE) {
      req.addEventListener('success', () => this.transaction.abort())
    }
    return req
  })
}

describe('browser workspace id accessor', () => {
  beforeEach(async () => {
    resetBrowserWorkspaceIdForTests()
    setWhiteboardDbNameForTests(DB_NAME)
    await clearNamedDb(DB_NAME)
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    resetBrowserWorkspaceIdForTests()
    await clearNamedDb(DB_NAME)
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

  it('switches a resolved identity to another workspace in this registry', async () => {
    // ADR-0019's switch, at the layer that has to move. The accessor resolves
    // ONCE by design — a boot-time resolve every later read is served from —
    // so a switcher needs a second door, or the shipped switch has to be a
    // document load.
    const index = new IdbDocumentIndex(DB_NAME)
    const first = await resolveBrowserWorkspaceId(DB_NAME)
    await index.createWorkspace({ workspaceId: LATER_ULID, segment: 'second' })

    const moved = await switchBrowserWorkspace('me/second', DB_NAME)

    expect(moved?.workspaceId).toBe(LATER_ULID)
    expect(getBrowserWorkspaceId()).toBe(LATER_ULID)
    expect(getBrowserWorkspaceId()).not.toBe(first)
    expect(getBrowserWorkspaceIdentity().segment).toBe('second')
  })

  // ADR-0053 decision 2: an old one-component segment address is the id form,
  // so it names nothing rather than being redirected into `me`.
  it('does not switch to a bare segment', async () => {
    const index = new IdbDocumentIndex(DB_NAME)
    const first = await resolveBrowserWorkspaceId(DB_NAME)
    await index.createWorkspace({ workspaceId: LATER_ULID, segment: 'second' })

    expect(await switchBrowserWorkspace('second', DB_NAME)).toBeNull()
    expect(getBrowserWorkspaceId()).toBe(first)
  })

  it('a registry read whose transaction aborts fails rather than hanging', async () => {
    const first = await resolveBrowserWorkspaceId(DB_NAME)
    await new IdbDocumentIndex(DB_NAME).createWorkspace({ workspaceId: LATER_ULID, segment: 'x' })
    abortRegistryReadAfterAnswer()

    await expect(switchBrowserWorkspace('x', DB_NAME)).rejects.toThrow()
    expect(getBrowserWorkspaceId()).toBe(first)
  })

  it('leaves a removed workspace for one this registry still keeps', async () => {
    const index = new IdbDocumentIndex(DB_NAME)
    await index.createWorkspace({ workspaceId: EARLIER_ULID })
    await index.createWorkspace({ workspaceId: LATER_ULID, segment: 'kept' })
    await switchBrowserWorkspace(EARLIER_ULID, DB_NAME)
    await removeRow(EARLIER_ULID)

    const next = await leaveRemovedWorkspace(EARLIER_ULID, DB_NAME)

    expect(next?.workspaceId).toBe(LATER_ULID)
    expect(getBrowserWorkspaceId()).toBe(LATER_ULID)
  })

  it('stays put when the removed workspace is not the one shown, or nothing else is kept', async () => {
    const index = new IdbDocumentIndex(DB_NAME)
    await index.createWorkspace({ workspaceId: EARLIER_ULID })
    await switchBrowserWorkspace(EARLIER_ULID, DB_NAME)

    expect(await leaveRemovedWorkspace(LATER_ULID, DB_NAME)).toBeNull()
    expect(getBrowserWorkspaceId()).toBe(EARLIER_ULID)

    // The registry also holds the default workspace the first read mints.
    await clearRows()
    expect(await leaveRemovedWorkspace(EARLIER_ULID, DB_NAME)).toBeNull()
    expect(getBrowserWorkspaceId()).toBe(EARLIER_ULID)
  })

  it('registerTestWorkspace gives the resolved identity a registry row', async () => {
    setBrowserWorkspaceIdForTests(LATER_ULID)
    await registerTestWorkspace()

    expect(await switchBrowserWorkspace(LATER_ULID, DB_NAME)).not.toBeNull()
  })

  it('a stored segment the read schema drops names nothing, here as in the index', async () => {
    // A row written before the identity bounds (or by a writer that skipped
    // them) can carry a segment the model refuses — here one shaped like
    // ANOTHER workspace's canonical id. The index reads that layer as absent;
    // a resolver that honoured it would open B for an address naming A.
    const index = new IdbDocumentIndex(DB_NAME)
    await index.createWorkspace({ workspaceId: EARLIER_ULID, segment: 'alpha' })
    await registerTestWorkspace({ workspaceId: LATER_ULID, segment: EARLIER_ULID })

    expect((await index.resolveWorkspace(EARLIER_ULID))?.workspaceId).toBe(EARLIER_ULID)
    expect((await switchBrowserWorkspace(EARLIER_ULID, DB_NAME))?.workspaceId).toBe(EARLIER_ULID)
    expect(getBrowserWorkspaceIdentity()).toEqual({ workspaceId: EARLIER_ULID, segment: 'alpha' })
    expect(await switchBrowserWorkspace(LATER_ULID, DB_NAME)).toEqual({ workspaceId: LATER_ULID })

    resetBrowserWorkspaceIdForTests()
    expect(await resolveBrowserWorkspaceId(DB_NAME, EARLIER_ULID)).toBe(EARLIER_ULID)
  })

  it('a refused lowercase id-shaped segment is not a handle either', async () => {
    const index = new IdbDocumentIndex(DB_NAME)
    await registerTestWorkspace({ workspaceId: LATER_ULID, segment: EARLIER_ULID.toLowerCase() })

    expect(await index.resolveWorkspace(EARLIER_ULID.toLowerCase())).toBeNull()
    expect(await switchBrowserWorkspace(EARLIER_ULID.toLowerCase(), DB_NAME)).toBeNull()
  })

  it('skips, and says so, a registry row whose id does not read', async () => {
    // Keyed to sort FIRST, so an address-less resolve that kept it would
    // land on it rather than on the workspace that does read.
    await registerTestWorkspace({ workspaceId: '00 not an id', segment: 'broken' })
    await registerTestWorkspace({ workspaceId: LATER_ULID, segment: 'kept' })

    expect(await resolveBrowserWorkspaceId(DB_NAME)).toBe(LATER_ULID)
    expect(await switchBrowserWorkspace('me/broken', DB_NAME)).toBeNull()
    expect(await switchBrowserWorkspace('00 not an id', DB_NAME)).toBeNull()
    expect(await switchBrowserWorkspace('me/kept', DB_NAME)).toEqual({
      workspaceId: LATER_ULID,
      segment: 'kept',
    })
    await expectLoggedFailure('skipped a workspace registry row that does not read')
  })

  it('refuses a handle this registry does not hold, leaving the identity where it was', async () => {
    // STRICT, unlike the boot resolve one line up, and the asymmetry is the
    // point. Boot is lenient because a stale bookmark should still open the
    // app and there is no previous state worth keeping. A switch has one:
    // silently landing on first-listed would answer a request to go
    // somewhere by going somewhere else, and the address would then be
    // rewritten to match a place nobody asked for.
    const before = await resolveBrowserWorkspaceId(DB_NAME)

    const moved = await switchBrowserWorkspace('no-such-workspace', DB_NAME)

    expect(moved).toBeNull()
    expect(getBrowserWorkspaceId()).toBe(before)
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
    // A resolver that asserts the registry holds EXACTLY one row and rejects
    // otherwise turns a second browser workspace from a degradation into an
    // app that cannot boot. Not resolving to a PARTICULAR one here: which one
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
    expect(await resolveBrowserWorkspaceId(DB_NAME, 'me/second')).toBe(LATER_ULID)
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

  it('the handle is the qualified segment when there is one, the id when there is not', () => {
    // What an ADDRESS carries. Both arms are live: a v15+ registry row has a
    // segment, and a row written before that carrier does not. The browser
    // holds one namespace, `me` (ADR-0053).
    setBrowserWorkspaceIdForTests('01ARZ3NDEKTSV4RRFFQ69G5FAV', 'design-team')
    expect(browserWorkspaceHandleOrNull()).toBe('me/design-team')

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
