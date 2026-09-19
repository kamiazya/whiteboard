import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LoroDoc, LoroMap } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Swap DATA_DIR to a temp directory through vi.mock.
let tempDir: string

vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  getDataDir: () => tempDir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

// Use dynamic import so it runs after the mock is resolved.
const {
  saveDocument,
  loadDocument,
  compactDocument,
  setDocumentSavedListener,
  openWorkspaceDocIfStored,
} = await import('./document-store.js')
const {
  scheduleAutoCompact,
  uninstallAutoCompact,
  disposeAutoCompact,
  _inFlightAutoCompactCountForTests,
  _isDisposingAutoCompactForTests,
  _awaitAutoCompactFiredForTests,
  _awaitAutoCompactIdleForTests,
  _loopHoldersCountForTests,
  _autoCompactTimerCountForTests,
} = await import('./auto-compact.js')
const { captureLogsForTests } = await import('../log.js')
const { FileVersionStore } = await import('./version-store.js')
const { createIsolatedDb } = await import('./db/test-helpers.js')

const { readWorkspaceMeta } = await import('@kamiazya/whiteboard-loro-adapter')

let handle: Awaited<ReturnType<typeof createIsolatedDb>>

/**
 * What the scheduler DECLINED for, phrased to sit in an assertion message.
 *
 * `expected null not to be null` on a stamp names neither of the things that
 * produce it. Reading the reasons back says which: nothing to gain, a lost
 * generation fence, or no decline reported at all.
 */
function declinedFor(records: { scope: string; msg: string; data?: unknown }[]): string {
  const reasons = records
    .filter((record) => record.scope === 'auto-compact' && record.msg === 'declined')
    .map((record) => String((record.data as { reason?: unknown } | undefined)?.reason))
  return reasons.length === 0 ? 'and logged no decline at all' : `declining: ${reasons.join(', ')}`
}

/**
 * The workspace's compaction stamp, or null when nothing has compacted yet.
 *
 * Takes no path on purpose: compaction folds the WORKSPACE record (S4b/S7),
 * so there is one stamp per workspace and not one per document.
 */
async function readLastCompactedAt(): Promise<number | null> {
  const workspaceDoc = await openWorkspaceDocIfStored('session1')
  if (workspaceDoc === null) return null
  return readWorkspaceMeta(workspaceDoc).lastCompactedAt ?? null
}

async function setupIsolatedDb(): Promise<void> {
  handle = await createIsolatedDb({ dataDir: tempDir })
}

async function teardownIsolatedDb(): Promise<void> {
  await handle.dispose()
}

// Split from document-store.test.ts by topic (compaction: manual + auto);
// the vi.mock + awaited-import harness is per-file by necessity.

describe('compactDocument', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-compact-test-'))
    await setupIsolatedDb()
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(tempDir, 'session1'), { recursive: true })
  })

  afterEach(async () => {
    await teardownIsolatedDb()
    await rm(tempDir, { recursive: true, force: true })
  })

  it('does not compact when no version exists', async () => {
    const doc = new LoroDoc()
    doc.getMovableList('elements').insert(0, 'x')
    doc.commit()
    await saveDocument('session1', 'test', doc)

    const store = new FileVersionStore()
    const result = await compactDocument('session1', 'test', store)
    expect(result.compacted).toBe(false)
    expect(result.reason).toBe('no-versions')
  })

  it('returns no-file when the .loro file is missing', async () => {
    const store = new FileVersionStore()
    const result = await compactDocument('session1', 'missing', store)
    expect(result).toEqual({ compacted: false, beforeBytes: 0, afterBytes: 0, reason: 'no-file' })
  })

  // canvas blobs no longer share their parent directory with the session
  // dir, so the previous "non-directory parent" stat failure no longer
  // applies. Coverage of the corrupt-snapshot branch lives below.

  it('treats an invalid workspace record as corruption instead of compacting over it', async () => {
    const { getDb } = await import('./db/index.js')
    const { LibsqlDocumentStore } = await import('./libsql/libsql-document-store.js')
    const { chunkSnapshot } = await import('@kamiazya/whiteboard-ports')
    const { _clearWorkspaceDocCacheForTests } = await import('./document-store.js')
    const doc = new LoroDoc()
    const store = new FileVersionStore()
    await saveDocument('session1', 'broken', doc)
    await store.save('session1', 'broken', doc, { auto: true })
    const db = await getDb(tempDir)
    // Corrupt the workspace record's snapshot rows directly — the
    // beforeBytes read succeeds (the header is intact), but re-opening the
    // live workspace document decodes the garbage bytes and must surface
    // corruption rather than silently compacting an empty document over
    // real data.
    const libsqlStore = new LibsqlDocumentStore(db)
    const { manifest, chunks } = chunkSnapshot(Buffer.from('not-a-loro-snapshot'), 1_000_000)
    await libsqlStore.saveSnapshot({
      docRef: { kind: 'workspace-tree', workspaceId: 'session1' },
      manifest,
      chunks,
      frontier: new Uint8Array(),
    })
    _clearWorkspaceDocCacheForTests()

    await expect(compactDocument('session1', 'broken', store)).rejects.toThrow()
  })

  it('compacts at a version cut point while keeping restore working', async () => {
    const { LoroMap } = await import('loro-crdt')
    const doc = new LoroDoc()
    const list = doc.getMovableList('elements')
    // Build a larger op log by repeatedly adding and updating elements.
    for (let i = 0; i < 30; i++) {
      const m = list.insertContainer(list.length, new LoroMap())
      m.set('id', `elem-${i}`)
      m.set('x', i)
    }
    doc.commit()
    await saveDocument('session1', 'test', doc)

    const store = new FileVersionStore()
    const v = await store.save('session1', 'test', doc, { auto: true })

    // Add more operations after the saved version.
    for (let i = 0; i < 30; i++) {
      const m = list.insertContainer(list.length, new LoroMap())
      m.set('id', `extra-${i}`)
    }
    doc.commit()
    await saveDocument('session1', 'test', doc, { overwrite: true })

    const result = await compactDocument('session1', 'test', store)
    expect(result.compacted).toBe(true)
    expect(result.afterBytes).toBeLessThan(result.beforeBytes)

    // The live state should still have all 60 elements after compaction.
    const live = await loadDocument('session1', 'test')
    expect(live.getMovableList('elements').length).toBe(60)

    // Restoring the oldest version should still work at the cut point.
    const past = await store.load('session1', v.id, live)
    expect(past).not.toBeNull()
    expect(past!.getMovableList('elements').length).toBe(30)

    // Compaction prunes history, not state, so the frontier written for the
    // shallow workspace record must still match the live workspace doc's
    // current oplog version — later saves keep appending from it.
    const { getDb } = await import('./db/index.js')
    const { LibsqlDocumentStore } = await import('./libsql/libsql-document-store.js')
    const { getWorkspaceDoc } = await import('./document-store.js')
    const db = await getDb(tempDir)
    const libsqlStore = new LibsqlDocumentStore(db)
    const frontierResult = await libsqlStore.readFrontier({
      docRef: { kind: 'workspace-tree', workspaceId: 'session1' },
    })
    const workspaceDoc = await getWorkspaceDoc('session1')
    expect(frontierResult?.frontier).toEqual(workspaceDoc.oplogVersion().encode())
  })

  it('writes lastCompactedAt only on successful compaction', async () => {
    const { LoroMap } = await import('loro-crdt')

    // Case 1: no version → reason='no-versions' → lastCompactedAt stays null.
    const empty = new LoroDoc()
    empty.getMovableList('elements').insert(0, 'x')
    empty.commit()
    await saveDocument('session1', 'untouched', empty)
    const noopStore = new FileVersionStore()
    const noop = await compactDocument('session1', 'untouched', noopStore)
    expect(noop.reason).toBe('no-versions')
    expect(await readLastCompactedAt()).toBeNull()

    // Case 2: version cut available → reason='ok' → lastCompactedAt is set.
    const doc = new LoroDoc()
    const list = doc.getMovableList('elements')
    for (let i = 0; i < 30; i++) {
      const m = list.insertContainer(list.length, new LoroMap())
      m.set('id', `elem-${i}`)
    }
    doc.commit()
    await saveDocument('session1', 'big', doc)
    const store = new FileVersionStore()
    await store.save('session1', 'big', doc, { auto: true })
    for (let i = 0; i < 30; i++) {
      const m = list.insertContainer(list.length, new LoroMap())
      m.set('id', `extra-${i}`)
    }
    doc.commit()
    await saveDocument('session1', 'big', doc, { overwrite: true })

    const before = Date.now()
    const result = await compactDocument('session1', 'big', store)
    expect(result.compacted).toBe(true)
    const after = Date.now()
    const stamp = await readLastCompactedAt()
    expect(stamp).not.toBeNull()
    expect(stamp!).toBeGreaterThanOrEqual(before)
    expect(stamp!).toBeLessThanOrEqual(after)

    // Workspace-level mirror (dual-plane collapse S4b): compaction operates
    // on the workspace record's oplog, so the shared timestamp lives on the
    // workspace meta — and only successful compaction writes it, same as the
    // row stamp ('untouched' compacted nothing above).
    const { openWorkspaceDocIfStored } = await import('./document-store.js')
    const { readWorkspaceMeta } = await import('@kamiazya/whiteboard-loro-adapter')
    const workspaceDoc = await openWorkspaceDocIfStored('session1')
    expect(workspaceDoc).not.toBeNull()
    if (workspaceDoc === null) throw new Error('unreachable')
    const wsStamp = readWorkspaceMeta(workspaceDoc).lastCompactedAt
    expect(wsStamp).toBeGreaterThanOrEqual(before)
    expect(wsStamp).toBeLessThanOrEqual(after)
  })

  // compactDocument reads the workspace record, exports the shallow
  // snapshot from the live workspace doc, and writes it back — all under the
  // workspace write lock, the same lock every content writer holds. A
  // concurrent tool write therefore lands strictly before or strictly after
  // the fold, and survives either way.
  it('does not lose a concurrent tool write racing the compaction', async () => {
    const { getDb } = await import('./db/index.js')
    const { getDataDir } = await import('../config.js')
    const { resolveDocumentIdAtPath } = await import('./document-store.js')
    const { LibsqlDocumentStore } = await import('./libsql/libsql-document-store.js')
    const { WorkspaceRoutedDocumentStore } = await import('./workspace-plane.js')
    const { chunkSnapshot, reassembleSnapshot } = await import('@kamiazya/whiteboard-ports')

    const doc = new LoroDoc()
    const list = doc.getMovableList('elements')
    for (let i = 0; i < 30; i++) {
      const m = list.insertContainer(list.length, new LoroMap())
      m.set('id', `elem-${i}`)
    }
    doc.commit()
    await saveDocument('session1', 'test', doc)

    const store = new FileVersionStore()
    await store.save('session1', 'test', doc, { auto: true })

    for (let i = 0; i < 30; i++) {
      const m = list.insertContainer(list.length, new LoroMap())
      m.set('id', `extra-${i}`)
    }
    doc.commit()
    await saveDocument('session1', 'test', doc, { overwrite: true })

    const db = await getDb(getDataDir())
    const documentId = (await resolveDocumentIdAtPath('session1', 'test'))!

    // Hold the cut lookup open so the tool write races into compaction's
    // window instead of trivially serializing before it.
    const delayedStore = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === 'earliestWorkspaceFrontiers') {
          return async (workspaceId: string) => {
            await new Promise((r) => setTimeout(r, 60))
            return target.earliestWorkspaceFrontiers(workspaceId)
          }
        }
        return Reflect.get(target, prop, receiver)
      },
    })

    const compactPromise = compactDocument('session1', 'test', delayedStore)
    await new Promise((r) => setTimeout(r, 20))
    const routed = new WorkspaceRoutedDocumentStore(new LibsqlDocumentStore(db))
    const docRef = { kind: 'document' as const, workspaceId: 'session1', documentId }
    const existing = await routed.loadSnapshot({ docRef })
    const toolDoc = new LoroDoc()
    toolDoc.import(reassembleSnapshot(existing!.manifest, existing!.chunks))
    toolDoc.getMap('root').set('agentMarker', 'concurrent-edit')
    toolDoc.commit()
    const chunked = chunkSnapshot(new Uint8Array(toolDoc.export({ mode: 'snapshot' })), 1_000_000)
    const toolWrite = routed.saveSnapshot({
      docRef,
      manifest: chunked.manifest,
      chunks: chunked.chunks,
      frontier: new Uint8Array(toolDoc.oplogVersion().encode()),
    })

    await Promise.all([compactPromise, toolWrite])

    const after = await loadDocument('session1', 'test')
    expect(after.getMap('root').get('agentMarker')).toBe('concurrent-edit')
    expect(after.getMovableList('elements').length).toBe(60)
  })
})

// `document-store.deleteDocument` is gone: it was a second implementation of
// `wbDocumentDelete`, and the HTTP route that called it is now an adapter
// over the operation (ADR-0018). These cases are storage-level — blobs,
// thumbnails, rows, the descendant refusal — so they stay at this layer and
// drive the surviving implementation instead.
//
describe('auto-compact', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-auto-compact-test-'))
    await setupIsolatedDb()
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(tempDir, 'session1'), { recursive: true })
  })

  afterEach(async () => {
    uninstallAutoCompact()
    await disposeAutoCompact()
    await teardownIsolatedDb()
    await rm(tempDir, { recursive: true, force: true })
  })

  it('saveDocument notifies the registered document-saved listener', async () => {
    const trigger = vi.fn<(workspaceId: string, path: string) => void>()
    setDocumentSavedListener(trigger)
    await saveDocument('session1', 'foo', new LoroDoc())
    expect(trigger).toHaveBeenCalledTimes(1)
    expect(trigger).toHaveBeenCalledWith('session1', 'foo')
  })

  it('scheduleAutoCompact debounces rapid triggers into a single compaction', async () => {
    const { LoroMap } = await import('loro-crdt')

    // Build a canvas with a version cut + extra ops so compactDocument
    // actually has work to do (otherwise the debounced firing would
    // just return reason: 'no-versions' and lastCompactedAt stays null).
    const doc = new LoroDoc()
    const list = doc.getMovableList('elements')
    for (let i = 0; i < 30; i++) {
      const m = list.insertContainer(list.length, new LoroMap())
      m.set('id', `e-${i}`)
    }
    doc.commit()
    await saveDocument('session1', 'big', doc)
    const store = new FileVersionStore()
    await store.save('session1', 'big', doc, { auto: true })
    for (let i = 0; i < 30; i++) {
      const m = list.insertContainer(list.length, new LoroMap())
      m.set('id', `x-${i}`)
    }
    doc.commit()
    await saveDocument('session1', 'big', doc, { overwrite: true })

    expect(await readLastCompactedAt()).toBeNull()

    // A compaction that THROWS is caught inside the scheduler and logged, so
    // without this capture a failed compaction reaches the reader as a null
    // stamp — a message that names the assertion rather than the cause.
    const logs = captureLogsForTests('info')

    // Three rapid triggers within the debounce window must collapse into
    // a single compactDocument run. Use a tiny debounce so the test stays fast.
    scheduleAutoCompact('session1', 'big', store, { debounceMs: 50 })
    scheduleAutoCompact('session1', 'big', store, { debounceMs: 50 })
    scheduleAutoCompact('session1', 'big', store, { debounceMs: 50 })

    // The collapse itself, asserted where it is a FACT rather than a race:
    // three schedules leave one timer, and the count is readable synchronously
    // on the line after the third call. Everything below is about what that
    // one timer then does.
    expect(
      _autoCompactTimerCountForTests(),
      'three rapid triggers did not collapse into exactly one pending debounce',
    ).toBe(1)

    // Wait for the debounce to fire and its compactDocument write to settle.
    // The seam waits for that event rather than for a budget to elapse — the
    // budget is what used to fail here under a shared runner's contention.
    await _awaitAutoCompactIdleForTests()
    const stamp = await readLastCompactedAt()
    logs.restore()

    expect(
      logs.records.filter((record) => record.scope === 'auto-compact' && record.msg === 'failed'),
      'the debounced compaction threw and was swallowed, so no stamp was ever written',
    ).toEqual([])
    const why = `the compaction settled but wrote no stamp, ${declinedFor(logs.records)}`
    expect(stamp, why).not.toBeNull()
    const settled = stamp!

    // Further idle time without a new trigger must NOT re-compact. This half
    // is an inherently bounded negative wait — keep it real rather than
    // deleting the assertion.
    await new Promise((r) => setTimeout(r, 150))
    expect(await readLastCompactedAt()).toBe(settled)
  })

  it('keeps the cached doc coherent through an auto-compact — the next save does not clobber the compacted record', async () => {
    // The legacy trap was a cached full doc re-exporting its entire history
    // over a freshly shallowed record. The workspace record's compaction
    // writes its OWN live doc's frontier, so the cache needs no eviction —
    // this pins that a post-compact edit round-trips instead of resurrecting
    // pre-compact bytes or losing the edit.
    const { LoroMap } = await import('loro-crdt')
    const { peekDoc, clearCache } = await import('./doc-cache.js')
    const { getDoc } = await import('./document-store.js')

    clearCache()

    const doc = new LoroDoc()
    const list = doc.getMovableList('elements')
    for (let i = 0; i < 30; i++) {
      const m = list.insertContainer(list.length, new LoroMap())
      m.set('id', `e-${i}`)
    }
    doc.commit()
    await saveDocument('session1', 'cached', doc)
    const store = new FileVersionStore()
    await store.save('session1', 'cached', doc, { auto: true })
    for (let i = 0; i < 30; i++) {
      const m = list.insertContainer(list.length, new LoroMap())
      m.set('id', `x-${i}`)
    }
    doc.commit()
    await saveDocument('session1', 'cached', doc, { overwrite: true })

    await getDoc('session1', 'cached')
    expect(peekDoc('session1', 'cached')).toBeDefined()

    scheduleAutoCompact('session1', 'cached', store, { debounceMs: 50 })
    await _awaitAutoCompactIdleForTests()
    {
      const { openWorkspaceDocIfStored } = await import('./document-store.js')
      const { readWorkspaceMeta } = await import('@kamiazya/whiteboard-loro-adapter')
      const workspaceDoc = await openWorkspaceDocIfStored('session1')
      expect(
        workspaceDoc && (readWorkspaceMeta(workspaceDoc).lastCompactedAt ?? null),
      ).not.toBeNull()
    }

    // Edit and save AFTER the compaction, then reload from stored bytes
    // only: everything survives.
    const live = await getDoc('session1', 'cached')
    live.getMap('root').set('post-compact', 'edit')
    live.commit()
    await saveDocument('session1', 'cached', live, { overwrite: true })
    const { _clearWorkspaceDocCacheForTests } = await import('./document-store.js')
    clearCache()
    _clearWorkspaceDocCacheForTests()
    const reloaded = await loadDocument('session1', 'cached')
    expect(reloaded.getMovableList('elements').length).toBe(60)
    expect(reloaded.getMap('root').get('post-compact')).toBe('edit')
  })
})

describe('auto-compact disposal', () => {
  let disposedDb = false

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-auto-compact-dispose-test-'))
    await setupIsolatedDb()
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(tempDir, 'session1'), { recursive: true })
    disposedDb = false
  })

  afterEach(async () => {
    uninstallAutoCompact()
    await disposeAutoCompact()
    if (!disposedDb) {
      await teardownIsolatedDb()
    }
    await rm(tempDir, { recursive: true, force: true })
  })

  async function buildCompactableCanvas(
    path: string,
  ): Promise<InstanceType<typeof FileVersionStore>> {
    const { LoroMap } = await import('loro-crdt')
    const doc = new LoroDoc()
    const list = doc.getMovableList('elements')
    for (let i = 0; i < 30; i++) {
      const m = list.insertContainer(list.length, new LoroMap())
      m.set('id', `e-${i}`)
    }
    doc.commit()
    await saveDocument('session1', path, doc)
    const store = new FileVersionStore()
    await store.save('session1', path, doc, { auto: true })
    for (let i = 0; i < 30; i++) {
      const m = list.insertContainer(list.length, new LoroMap())
      m.set('id', `x-${i}`)
    }
    doc.commit()
    await saveDocument('session1', path, doc, { overwrite: true })
    return store
  }

  // compactDocument normally settles fast enough (in-memory DB, tiny fixture)
  // that polling for "in flight" would race the compaction to zero. Delay
  // just the cut lookup — an await compactDocument makes early on — so tests
  // can deterministically observe the in-flight window instead of depending
  // on real-clock luck.
  function withDelayedEarliestFrontiers(
    store: InstanceType<typeof FileVersionStore>,
    delayMs: number,
  ): InstanceType<typeof FileVersionStore> {
    return new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === 'earliestWorkspaceFrontiers') {
          return async (workspaceId: string) => {
            await new Promise((r) => setTimeout(r, delayMs))
            return target.earliestWorkspaceFrontiers(workspaceId)
          }
        }
        return Reflect.get(target, prop, receiver)
      },
    })
  }

  // The two seams these tests pin are what the rest of this file waits on.
  // They replaced `vi.waitFor(..., { timeout: 2000 })` — a second, tighter
  // wall-clock ceiling nested inside the per-test one, around work a shared
  // CI runner schedules. Under momentary contention that ceiling was the only
  // thing that could fail, and it did, on a commit that re-ran green.
  it('_awaitAutoCompactIdleForTests resolves only once the debounced compaction has settled', async () => {
    const store = await buildCompactableCanvas('idle-seam')

    // Held open by a GATE the test releases, not by a sleep. The first draft
    // used `withDelayedEarliestFrontiers(store, 100)` and read the stamp
    // before waiting, and CI's 5x stress of the changed file failed it once
    // in five with `expected null not to be null` — a message that names
    // neither of the two things that produce it (the compaction never ran, or
    // it ran and wrote nothing). A duration can close before the action under
    // test; a condition cannot, and each step below now fails saying which
    // one broke.
    let releaseCompaction: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      releaseCompaction = resolve
    })
    const gatedStore = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === 'earliestWorkspaceFrontiers') {
          return async (workspaceId: string) => {
            await gate
            return target.earliestWorkspaceFrontiers(workspaceId)
          }
        }
        return Reflect.get(target, prop, receiver)
      },
    })

    const logs = captureLogsForTests('info')
    scheduleAutoCompact('session1', 'idle-seam', gatedStore, { debounceMs: 1 })
    // Throws naming the premise if the schedule was a no-op, instead of
    // leaving that to be inferred from a null stamp three lines later.
    await _awaitAutoCompactFiredForTests()

    let idleResolved = false
    const idle = _awaitAutoCompactIdleForTests().then(() => {
      idleResolved = true
    })
    try {
      // setImmediate runs after the microtask queue has drained, so a seam
      // that returned without waiting has resolved by here — no clock, and
      // no counting of microtask hops.
      await new Promise((resolve) => setImmediate(resolve))
      expect(idleResolved, 'the seam resolved while the compaction was still held').toBe(false)
    } finally {
      // In a `finally` because a failed assertion above would otherwise leave
      // the compaction gated shut forever, and this describe's afterEach
      // awaits it — so the test would HANG instead of reporting the sentence
      // it just failed on. Verified by running the mutant: without this, the
      // whole file times out and names nothing.
      releaseCompaction()
    }
    await idle
    logs.restore()

    expect(_inFlightAutoCompactCountForTests()).toBe(0)
    expect(
      await readLastCompactedAt(),
      `the compaction settled but wrote no lastCompactedAt, ${declinedFor(logs.records)}`,
    ).not.toBeNull()
  })

  it("releases an abandoned wait's keep-alive when the timers are cleared, instead of leaving it running", async () => {
    const store = await buildCompactableCanvas('abandoned-wait')
    let releaseCompaction: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      releaseCompaction = resolve
    })
    const gatedStore = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === 'earliestWorkspaceFrontiers') {
          return async (workspaceId: string) => {
            await gate
            return target.earliestWorkspaceFrontiers(workspaceId)
          }
        }
        return Reflect.get(target, prop, receiver)
      },
    })

    expect(_loopHoldersCountForTests()).toBe(0)
    scheduleAutoCompact('session1', 'abandoned-wait', gatedStore, { debounceMs: 1 })
    await _awaitAutoCompactFiredForTests()

    // Started and deliberately NOT awaited: this is a wait whose test timed
    // out, so its own `finally` will never run. The keep-alive it holds is
    // not unref'd by design, so without a reap it would keep the worker's
    // event loop alive for the rest of the run — a leak that shows up much
    // later as a shard that will not exit, blaming nothing.
    void _awaitAutoCompactIdleForTests()
    try {
      expect(_loopHoldersCountForTests()).toBe(1)

      uninstallAutoCompact()
      expect(
        _loopHoldersCountForTests(),
        'the abandoned wait is still holding the event loop open',
      ).toBe(0)
    } finally {
      // Same reason as the gated test above: a failed assertion here would
      // otherwise leave the compaction held, and afterEach awaits it — so
      // the run would report `Hook timed out in 10000ms` against the
      // afterEach instead of the sentence that actually failed. Measured on
      // the mutant, which produced both messages before this `finally`.
      releaseCompaction()
    }
    await disposeAutoCompact()
  })

  it('_awaitAutoCompactFiredForTests says so rather than hanging when nothing is pending or in flight', async () => {
    await expect(_awaitAutoCompactFiredForTests()).rejects.toThrow(
      /nothing was scheduled, or it already settled/,
    )
  })

  it('logs which reason a scheduled compaction declined for, instead of dropping it and leaving a null stamp to explain itself', async () => {
    // `compactDocument` names four reasons it writes no stamp — `no-file`,
    // `no-versions`, `no-gain`, `raced`. The scheduler read only
    // `result.compacted`, so all four reached a reader as the same silence:
    // a null stamp and no record of why.
    const empty = new LoroDoc()
    empty.getMovableList('elements').insert(0, 'x')
    empty.commit()
    await saveDocument('session1', 'undeclared', empty)

    const logs = captureLogsForTests('info')
    scheduleAutoCompact('session1', 'undeclared', new FileVersionStore(), { debounceMs: 1 })
    await _awaitAutoCompactIdleForTests()
    logs.restore()

    expect(
      logs.records
        .filter((record) => record.scope === 'auto-compact' && record.msg === 'declined')
        .map((record) => record.data?.reason),
    ).toEqual(['no-versions'])
  })

  it('cancels the pending debounce when the DB is disposed before it fires, instead of touching the destroyed driver', async () => {
    const store = await buildCompactableCanvas('big')
    const logs = captureLogsForTests('warning')

    // Do NOT call uninstallAutoCompact() here — the point of this test
    // is that DB disposal alone (without that manual call) must cancel the
    // pending timer.
    scheduleAutoCompact('session1', 'big', store, { debounceMs: 20 })
    await teardownIsolatedDb()
    disposedDb = true

    // Wait past the debounce window. If the timer was not cancelled, its
    // fired compactDocument call would hit the destroyed driver and log a
    // 'failed' warning.
    await new Promise((r) => setTimeout(r, 150))
    logs.restore()

    const autoCompactRecords = logs.records.filter((r) => r.scope === 'auto-compact')
    expect(autoCompactRecords).toHaveLength(0)
  })

  it('disposeAutoCompact awaits an already-fired in-flight compaction before resolving', async () => {
    const store = await buildCompactableCanvas('cached')

    scheduleAutoCompact('session1', 'cached', withDelayedEarliestFrontiers(store, 100), {
      debounceMs: 1,
    })
    await _awaitAutoCompactFiredForTests()
    expect(_inFlightAutoCompactCountForTests()).toBeGreaterThan(0)

    await disposeAutoCompact()

    expect(_inFlightAutoCompactCountForTests()).toBe(0)
    expect(await readLastCompactedAt()).not.toBeNull()
  })

  it('disposeAutoCompact refuses a reschedule attempted while disposal is in progress, instead of racing a timer against the next clear pass', async () => {
    const store = await buildCompactableCanvas('reentrant')

    // Simulates loadDocument()'s legacy-migration path resuming mid-compaction
    // and calling saveDocument(), which re-invokes the auto-compact trigger and
    // attempts to schedule a fresh timer. The reschedule is gated on an
    // explicit signal (not a wall-clock delay) so it fires deterministically
    // once _isDisposingAutoCompactForTests() is confirmed true, rather than
    // hoping a fixed sleep lands inside disposeAutoCompact's await window —
    // that race is what made the previous version of this test flaky under
    // load (CI run 29162596104).
    let releaseReschedule: () => void = () => undefined
    const rescheduleGate = new Promise<void>((resolve) => {
      releaseReschedule = resolve
    })
    const rescheduleCallCount = { count: 0 }
    const countingStore = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === 'earliestWorkspaceFrontiers') {
          return async (workspaceId: string) => {
            rescheduleCallCount.count += 1
            return target.earliestWorkspaceFrontiers(workspaceId)
          }
        }
        return Reflect.get(target, prop, receiver)
      },
    })
    const reentrantStore = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === 'earliestWorkspaceFrontiers') {
          return async (workspaceId: string) => {
            await rescheduleGate
            scheduleAutoCompact('session1', 'reentrant', countingStore, { debounceMs: 0 })
            return target.earliestWorkspaceFrontiers(workspaceId)
          }
        }
        return Reflect.get(target, prop, receiver)
      },
    })

    scheduleAutoCompact('session1', 'reentrant', reentrantStore, { debounceMs: 1 })
    await _awaitAutoCompactFiredForTests()
    expect(_inFlightAutoCompactCountForTests()).toBeGreaterThan(0)

    const disposePromise = disposeAutoCompact()
    // Confirm disposal has actually begun (and is blocked awaiting the
    // in-flight compaction above) before letting the reschedule proceed —
    // this is the exact interleaving the original bug report depended on
    // luck to hit. disposeAutoCompact raises the guard before its first
    // await, so the call above has already raised it: nothing to wait for.
    expect(_isDisposingAutoCompactForTests()).toBe(true)
    releaseReschedule()
    await disposePromise

    expect(_inFlightAutoCompactCountForTests()).toBe(0)
    // debounceMs: 0 still yields a macrotask tick before firing; give it a
    // chance to fire if it were ever going to, then confirm it didn't.
    await new Promise((r) => setTimeout(r, 20))
    expect(rescheduleCallCount.count).toBe(0)
  })

  it('disposes through the real DB lifecycle (createIsolatedDb().dispose()) without spinning up a replacement connection for a re-entrant getDb() call', async () => {
    const store = await buildCompactableCanvas('lifecycle')
    const { getDb } = await import('./db/index.js')
    let reentrantDb: Awaited<ReturnType<typeof getDb>> | null = null

    const reentrantStore = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === 'earliestWorkspaceFrontiers') {
          return async (workspaceId: string) => {
            await new Promise((r) => setTimeout(r, 100))
            // Mirrors a compaction resuming and touching the DB again
            // (e.g. via loadDocument()) while teardown is draining hooks.
            reentrantDb = await getDb(tempDir)
            return target.earliestWorkspaceFrontiers(workspaceId)
          }
        }
        return Reflect.get(target, prop, receiver)
      },
    })

    scheduleAutoCompact('session1', 'lifecycle', reentrantStore, { debounceMs: 1 })
    await _awaitAutoCompactFiredForTests()
    expect(_inFlightAutoCompactCountForTests()).toBeGreaterThan(0)

    const disposingDb = handle.db
    // Exercise the actual DB lifecycle API (createIsolatedDb().dispose(),
    // mirroring closeDb() in production) rather than calling
    // disposeAutoCompact() directly, so the cache-removal-vs-hook-ordering
    // fix in db/index.ts is covered from this store's perspective too.
    await teardownIsolatedDb()
    disposedDb = true

    expect(reentrantDb).toBe(disposingDb)
  })

  it('is idempotent, and scheduleAutoCompact still works after a dispose', async () => {
    const store = await buildCompactableCanvas('again')

    await disposeAutoCompact()
    await disposeAutoCompact()

    scheduleAutoCompact('session1', 'again', store, { debounceMs: 20 })
    await _awaitAutoCompactIdleForTests()
    expect(await readLastCompactedAt()).not.toBeNull()
  })

  it('composes with uninstallAutoCompact() in either order without dropping in-flight work', async () => {
    const store = await buildCompactableCanvas('composed')

    scheduleAutoCompact('session1', 'composed', withDelayedEarliestFrontiers(store, 100), {
      debounceMs: 1,
    })
    await _awaitAutoCompactFiredForTests()
    expect(_inFlightAutoCompactCountForTests()).toBeGreaterThan(0)

    // uninstallAutoCompact() stays synchronous and timer-only: it must
    // not swallow the in-flight compaction that is already running.
    uninstallAutoCompact()
    await disposeAutoCompact()

    expect(await readLastCompactedAt()).not.toBeNull()
  })

  /**
   * ADR-0020. Compaction folds a shallow snapshot out of the CACHED workspace
   * document, so a cache that is behind writes a record missing another
   * instance's ops — and the generation fence cannot catch it, because a
   * writer that only APPENDED never touched the generation.
   * `supersededDeltaCount` then drops exactly the delta that carried them.
   */
  it('does not fold away ops another instance appended while this cache was behind', async () => {
    const { getDb } = await import('./db/index.js')
    const { LibsqlDocumentStore } = await import('./libsql/libsql-document-store.js')
    const { DocumentStoreWorkspaceDocs } = await import('@kamiazya/whiteboard-workspace-index')

    // Enough history that a shallow snapshot is actually SMALLER than the
    // record — otherwise compaction answers `no-gain` and returns without
    // folding, and this case would pass against the very bug it is about.
    const doc = new LoroDoc()
    const elements = doc.getMovableList('elements')
    for (let i = 0; i < 400; i += 1) {
      elements.insert(i, `element-${i}-${'p'.repeat(200)}`)
      doc.commit()
    }
    await saveDocument('session1', 'page', doc)

    // Compaction refuses to cut history nothing pins, so the workspace needs
    // a version before the fold is even attempted.
    const store = new FileVersionStore()
    await store.save('session1', 'page', await loadDocument('session1', 'page'), { auto: false })

    // Another instance appends, straight to the store — this instance's
    // cached workspace document knows nothing about it.
    const docs = new DocumentStoreWorkspaceDocs(new LibsqlDocumentStore(await getDb(tempDir)))
    const theirs = (await docs.open('session1')) as LoroDoc
    theirs.getMap('meta').set('theirs', 'kept')
    theirs.commit()
    await docs.save('session1', theirs)

    const result = await compactDocument('session1', 'page', store)
    // Asserted, not assumed: a `no-gain` or `no-versions` answer means the
    // fold never ran and everything below would pass for the wrong reason.
    expect(result.reason).toBe('ok')
    expect(result.compacted).toBe(true)

    // The RECORD, not this process's cache: what survived the fold on disk.
    const settled = (await docs.open('session1')) as LoroDoc
    expect(settled.getMap('meta').get('theirs')).toBe('kept')
  })
})
