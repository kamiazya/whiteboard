import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let tempDir: string

vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  getDataDir: () => tempDir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

// Use dynamic import so the module loads after the mocks resolve.
const { clearDocCacheForTests, getOrLoad } = await import('./doc-cache.js')
const { storeScope } = await import('./store-scope.js')
const { getDoc } = await import('./document-store.js')
const { createIsolatedDb } = await import('./db/test-helpers.js')

let handle: Awaited<ReturnType<typeof createIsolatedDb>>

describe('getDoc', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-cache-test-'))
    await mkdir(join(tempDir, 'session1'), { recursive: true })
    handle = await createIsolatedDb({ dataDir: tempDir })
    clearDocCacheForTests()
  })

  afterEach(async () => {
    await handle.dispose()
    await rm(tempDir, { recursive: true, force: true })
    clearDocCacheForTests()
  })

  it('returns an empty LoroDoc on cache miss when the file does not exist', async () => {
    const doc = await getDoc('session1', 'nonexistent')
    expect(doc.getMovableList('elements').length).toBe(0)
  })

  it('returns the same instance on cache hit for the same key', async () => {
    const doc1 = await getDoc('session1', 'canvas-a')
    const doc2 = await getDoc('session1', 'canvas-a')
    expect(doc1).toBe(doc2)
  })

  it('returns different instances for different documents', async () => {
    const docA = await getDoc('session1', 'canvas-a')
    const docB = await getDoc('session1', 'canvas-b')
    expect(docA).not.toBe(docB)
  })
})

describe('the LRU bound', () => {
  beforeEach(() => clearDocCacheForTests())
  afterEach(() => clearDocCacheForTests())
  const scope = () => storeScope('/tmp/doc-cache-lru')

  it('holds 32 documents and evicts the least recently used on the 33rd', async () => {
    let loads = 0
    const load = async () => {
      loads += 1
      return new LoroDoc()
    }
    for (let i = 0; i < 32; i++) await getOrLoad('ws', `d${i}`, load, scope())
    for (let i = 0; i < 32; i++) await getOrLoad('ws', `d${i}`, load, scope())
    expect(loads).toBe(32)

    await getOrLoad('ws', 'd32', load, scope())
    expect(loads).toBe(33)
    await getOrLoad('ws', 'd1', load, scope())
    expect(loads).toBe(33)
    await getOrLoad('ws', 'd0', load, scope())
    expect(loads).toBe(34)
  })
})
