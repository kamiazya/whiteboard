/**
 * The synchronous accessor + async resolver for the browser's own workspace
 * id — the canonical ULID a v14+ database keys its `workspaces` row under.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setWhiteboardDbNameForTests } from './browser-idb.js'
import {
  getBrowserWorkspaceId,
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
})
