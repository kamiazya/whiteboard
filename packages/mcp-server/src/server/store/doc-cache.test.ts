import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LoroDoc, LoroMap } from 'loro-crdt'
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
const { getDoc, applyAndPersist, clearCache } = await import('./doc-cache.js')
const { createIsolatedDb } = await import('./db/test-helpers.js')

let handle: Awaited<ReturnType<typeof createIsolatedDb>>

describe('getDoc', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-cache-test-'))
    await mkdir(join(tempDir, 'session1'), { recursive: true })
    handle = await createIsolatedDb({ dataDir: tempDir })
    clearCache()
  })

  afterEach(async () => {
    await handle.dispose()
    await rm(tempDir, { recursive: true, force: true })
    clearCache()
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

describe('applyAndPersist', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-cache-test-'))
    await mkdir(join(tempDir, 'session1'), { recursive: true })
    handle = await createIsolatedDb({ dataDir: tempDir })
    clearCache()
  })

  afterEach(async () => {
    await handle.dispose()
    await rm(tempDir, { recursive: true, force: true })
    clearCache()
  })

  it('persists updater changes and returns the incremental update', async () => {
    const update = await applyAndPersist('session1', 'canvas-a', (doc) => {
      const list = doc.getMovableList('elements')
      const map = list.insertContainer(0, new LoroMap())
      map.set('id', 'elem-001')
      map.set('type', 'rectangle')
      doc.commit()
    })

    // The return value is a Uint8Array containing the Loro update binary.
    expect(update).toBeInstanceOf(Uint8Array)
    expect(update.length).toBeGreaterThan(0)

    // Verify persistence by clearing the cache and reloading.
    clearCache()
    const reloaded = await getDoc('session1', 'canvas-a')
    const elements = reloaded.getMovableList('elements').toJSON() as { id: string }[]
    expect(elements).toHaveLength(1)
    expect(elements[0].id).toBe('elem-001')
  })

  it('applies changes when an update binary is imported into an existing doc', async () => {
    // Record changes through applyAndPersist.
    const update = await applyAndPersist('session1', 'canvas-a', (doc) => {
      const list = doc.getMovableList('elements')
      const map = list.insertContainer(0, new LoroMap())
      map.set('id', 'elem-from-update')
      doc.commit()
    })

    // Importing the update into another client doc should reproduce the same state.
    const otherDoc = new LoroDoc()
    otherDoc.import(update)
    const elements = otherDoc.getMovableList('elements').toJSON() as { id: string }[]
    expect(elements).toHaveLength(1)
    expect(elements[0].id).toBe('elem-from-update')
  })
})
