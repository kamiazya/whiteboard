/**
 * The synchronous accessor + async resolver for the browser's own workspace
 * id — the canonical ULID a v14+ database keys its `workspaces` row under.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BROWSER_DEFAULT_SEGMENT, setWhiteboardDbNameForTests } from './browser-idb.js'
import {
  getBrowserWorkspaceId,
  getBrowserWorkspaceIdentity,
  resetBrowserWorkspaceIdForTests,
  resolveBrowserWorkspaceId,
  setBrowserWorkspaceIdForTests,
} from './browser-workspace-id.js'

const DB_NAME = 'whiteboard-workspace-id-test'

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
