import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
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

const { createFileGcSweeper } = await import('./file-gc-sweeper.js')
const { saveCanvas, loadCanvas } = await import('./canvas-store.js')
const { FileVersionStore } = await import('./version-store.js')
const { captureLogsForTests } = await import('../log.js')
const { createIsolatedDb } = await import('./db/test-helpers.js')

let handle: Awaited<ReturnType<typeof createIsolatedDb>>

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-file-gc-sweeper-test-'))
  handle = await createIsolatedDb({ dataDir: tempDir })
  vi.useFakeTimers()
})

afterEach(async () => {
  vi.useRealTimers()
  await handle.dispose()
  await rm(tempDir, { recursive: true, force: true })
})

// Deferred-promise helper: lets a test control exactly when a stubbed purge
// resolves, so overlap/single-flight scenarios are deterministic instead of
// racing real filesystem timing.
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('createFileGcSweeper scheduling', () => {
  it('does not run a pass before intervalMs elapses', async () => {
    const purge = vi.fn(async () => ({ purgedCount: 0, purgedBytes: 0 }))
    const sweeper = createFileGcSweeper({
      intervalMs: 1000,
      listWorkspaces: async () => [],
      discoverFsWorkspaces: async () => [],
      purge,
    })
    sweeper.start()
    await vi.advanceTimersByTimeAsync(999)
    expect(purge).not.toHaveBeenCalled()
    await sweeper.stop()
  })

  it('runs a pass after intervalMs elapses and reschedules', async () => {
    const purge = vi.fn(async () => ({ purgedCount: 0, purgedBytes: 0 }))
    const sweeper = createFileGcSweeper({
      intervalMs: 1000,
      listWorkspaces: async () => [{ workspaceId: 'ws_a' }],
      discoverFsWorkspaces: async () => [],
      purge,
    })
    sweeper.start()
    await vi.advanceTimersByTimeAsync(1000)
    expect(purge).toHaveBeenCalledTimes(1)
    expect(purge).toHaveBeenCalledWith('ws_a')

    await vi.advanceTimersByTimeAsync(1000)
    expect(purge).toHaveBeenCalledTimes(2)
    await sweeper.stop()
  })

  it('intervalMs=0 disables the sweeper: start() arms no timer', async () => {
    const purge = vi.fn(async () => ({ purgedCount: 0, purgedBytes: 0 }))
    const sweeper = createFileGcSweeper({
      intervalMs: 0,
      listWorkspaces: async () => [{ workspaceId: 'ws_a' }],
      discoverFsWorkspaces: async () => [],
      purge,
    })
    sweeper.start()
    await vi.advanceTimersByTimeAsync(10 * 24 * 60 * 60 * 1000)
    expect(purge).not.toHaveBeenCalled()
    await sweeper.stop()
  })
})

describe('createFileGcSweeper single-flight', () => {
  it('never starts a second pass via timer advancement while one is in flight (mutation-checked)', async () => {
    const d = deferred<{ purgedCount: number; purgedBytes: number }>()
    let purgeCalls = 0
    const purge = vi.fn(async () => {
      purgeCalls += 1
      return d.promise
    })
    const sweeper = createFileGcSweeper({
      intervalMs: 1000,
      listWorkspaces: async () => [{ workspaceId: 'ws_a' }],
      discoverFsWorkspaces: async () => [],
      purge,
    })
    sweeper.start()
    await vi.advanceTimersByTimeAsync(1000)
    expect(purgeCalls).toBe(1)

    // Advance several more intervals while the first pass's purge is still
    // pending -- a naive implementation without a single-flight guard would
    // fire a new pass on every elapsed interval.
    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(1000)
    expect(purgeCalls).toBe(1)

    d.resolve({ purgedCount: 0, purgedBytes: 0 })
    // Let the pass's .finally() run and reschedule.
    await Promise.resolve()
    await Promise.resolve()

    await vi.advanceTimersByTimeAsync(1000)
    expect(purgeCalls).toBe(2)

    await sweeper.stop()
  })

  it('two direct tick() calls while a pass is in flight return the same promise (concurrency seam)', async () => {
    const d = deferred<{ purgedCount: number; purgedBytes: number }>()
    let purgeCalls = 0
    const purge = vi.fn(async () => {
      purgeCalls += 1
      return d.promise
    })
    const sweeper = createFileGcSweeper({
      intervalMs: 1000,
      listWorkspaces: async () => [{ workspaceId: 'ws_a' }],
      discoverFsWorkspaces: async () => [],
      purge,
    })

    const first = sweeper.tick()
    // Let the pass's discovery (listWorkspaces/discoverFsWorkspaces) and its
    // purge call resolve their microtasks before the second tick() races in.
    await Promise.resolve()
    await Promise.resolve()
    const second = sweeper.tick()
    expect(purgeCalls).toBe(1)

    d.resolve({ purgedCount: 0, purgedBytes: 0 })
    await Promise.all([first, second])
    expect(purgeCalls).toBe(1)

    await sweeper.stop()
  })
})

describe('createFileGcSweeper stop()', () => {
  it('clears the pending timer -- no pass fires after stop()', async () => {
    const purge = vi.fn(async () => ({ purgedCount: 0, purgedBytes: 0 }))
    const sweeper = createFileGcSweeper({
      intervalMs: 1000,
      listWorkspaces: async () => [{ workspaceId: 'ws_a' }],
      discoverFsWorkspaces: async () => [],
      purge,
    })
    sweeper.start()
    await sweeper.stop()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(purge).not.toHaveBeenCalled()
  })

  it('awaits an in-flight pass before resolving', async () => {
    const d = deferred<{ purgedCount: number; purgedBytes: number }>()
    const purge = vi.fn(async () => d.promise)
    const sweeper = createFileGcSweeper({
      intervalMs: 1000,
      listWorkspaces: async () => [{ workspaceId: 'ws_a' }],
      discoverFsWorkspaces: async () => [],
      purge,
    })
    sweeper.start()
    await vi.advanceTimersByTimeAsync(1000)

    let stopped = false
    const stopPromise = sweeper.stop().then(() => {
      stopped = true
    })
    // Give microtasks a chance to run; stop() must NOT resolve while the
    // pass is still pending.
    await Promise.resolve()
    await Promise.resolve()
    expect(stopped).toBe(false)

    d.resolve({ purgedCount: 0, purgedBytes: 0 })
    await stopPromise
    expect(stopped).toBe(true)
  })

  it('double stop() and tick()-after-stop are no-ops', async () => {
    const purge = vi.fn(async () => ({ purgedCount: 0, purgedBytes: 0 }))
    const sweeper = createFileGcSweeper({
      intervalMs: 1000,
      listWorkspaces: async () => [],
      discoverFsWorkspaces: async () => [],
      purge,
    })
    sweeper.start()
    await sweeper.stop()
    await sweeper.stop()
    await sweeper.tick()
    expect(purge).not.toHaveBeenCalled()
  })
})

describe('createFileGcSweeper env parsing', () => {
  const ENV_KEY = 'WHITEBOARD_FILE_GC_INTERVAL_MS'
  let previous: string | undefined

  beforeEach(() => {
    previous = process.env[ENV_KEY]
  })

  afterEach(() => {
    if (previous === undefined) delete process.env[ENV_KEY]
    else process.env[ENV_KEY] = previous
  })

  it.each([
    '',
    '1.5',
    '1x',
    '-1',
    '1e3',
    ' 5',
    'abc',
  ])('falls back to the 24h default for invalid env value %j', async (raw) => {
    process.env[ENV_KEY] = raw
    const purge = vi.fn(async () => ({ purgedCount: 0, purgedBytes: 0 }))
    const sweeper = createFileGcSweeper({
      listWorkspaces: async () => [{ workspaceId: 'ws_a' }],
      discoverFsWorkspaces: async () => [],
      purge,
    })
    sweeper.start()
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000 - 1)
    expect(purge).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(purge).toHaveBeenCalledTimes(1)
    await sweeper.stop()
  })

  it('accepts a valid non-negative integer string', async () => {
    process.env[ENV_KEY] = '2000'
    const purge = vi.fn(async () => ({ purgedCount: 0, purgedBytes: 0 }))
    const sweeper = createFileGcSweeper({
      listWorkspaces: async () => [{ workspaceId: 'ws_a' }],
      discoverFsWorkspaces: async () => [],
      purge,
    })
    sweeper.start()
    await vi.advanceTimersByTimeAsync(2000)
    expect(purge).toHaveBeenCalledTimes(1)
    await sweeper.stop()
  })

  it('"0" from env disables the sweeper', async () => {
    process.env[ENV_KEY] = '0'
    const purge = vi.fn(async () => ({ purgedCount: 0, purgedBytes: 0 }))
    const sweeper = createFileGcSweeper({
      listWorkspaces: async () => [{ workspaceId: 'ws_a' }],
      discoverFsWorkspaces: async () => [],
      purge,
    })
    sweeper.start()
    await vi.advanceTimersByTimeAsync(10 * 24 * 60 * 60 * 1000)
    expect(purge).not.toHaveBeenCalled()
    await sweeper.stop()
  })

  it('an explicit intervalMs option overrides the env value', async () => {
    process.env[ENV_KEY] = '999999'
    const purge = vi.fn(async () => ({ purgedCount: 0, purgedBytes: 0 }))
    const sweeper = createFileGcSweeper({
      intervalMs: 500,
      listWorkspaces: async () => [{ workspaceId: 'ws_a' }],
      discoverFsWorkspaces: async () => [],
      purge,
    })
    sweeper.start()
    await vi.advanceTimersByTimeAsync(500)
    expect(purge).toHaveBeenCalledTimes(1)
    await sweeper.stop()
  })
})

describe('createFileGcSweeper per-workspace isolation', () => {
  it('logs and continues past a workspace whose purge throws, other workspaces still run', async () => {
    const cap = captureLogsForTests('debug')
    try {
      const purge = vi.fn(async (workspaceId: string) => {
        if (workspaceId === 'ws_bad') throw new Error('boom')
        return { purgedCount: 0, purgedBytes: 0 }
      })
      const sweeper = createFileGcSweeper({
        intervalMs: 1000,
        listWorkspaces: async () => [{ workspaceId: 'ws_bad' }, { workspaceId: 'ws_good' }],
        discoverFsWorkspaces: async () => [],
        purge,
      })
      await sweeper.tick()
      expect(purge).toHaveBeenCalledWith('ws_bad')
      expect(purge).toHaveBeenCalledWith('ws_good')

      const errRecords = cap.records.filter(
        (r) => r.scope === 'file-gc-sweeper' && r.level === 'error',
      )
      expect(errRecords.some((r) => r.data?.workspaceId === 'ws_bad')).toBe(true)
      await sweeper.stop()
    } finally {
      cap.restore()
    }
  })

  it('a whole-pass rejection (listWorkspaces rejects) does not crash and still reschedules', async () => {
    const cap = captureLogsForTests('debug')
    try {
      let shouldFail = true
      const purge = vi.fn(async () => ({ purgedCount: 0, purgedBytes: 0 }))
      const sweeper = createFileGcSweeper({
        intervalMs: 1000,
        listWorkspaces: async () => {
          if (shouldFail) throw new Error('db unavailable')
          return [{ workspaceId: 'ws_a' }]
        },
        discoverFsWorkspaces: async () => [],
        purge,
      })
      sweeper.start()
      await vi.advanceTimersByTimeAsync(1000)
      expect(purge).not.toHaveBeenCalled()
      const errRecords = cap.records.filter(
        (r) => r.scope === 'file-gc-sweeper' && r.level === 'error',
      )
      expect(errRecords.length).toBeGreaterThan(0)

      // Next interval, discovery succeeds -- proves the failed pass still
      // rescheduled the next one instead of getting stuck.
      shouldFail = false
      await vi.advanceTimersByTimeAsync(1000)
      expect(purge).toHaveBeenCalledTimes(1)
      await sweeper.stop()
    } finally {
      cap.restore()
    }
  })
})

describe('createFileGcSweeper default purge / versionStore wiring', () => {
  it('the default purge fn is invoked with a defined versionStore (mutation-checked)', async () => {
    // Uses the REAL default purge fn (no `purge` override) to prove
    // createFileGcSweeper wires its internally-constructed FileVersionStore
    // into purgeDanglingFiles, not just that a caller-supplied stub works.
    await saveCanvas(
      'ws_v',
      'evolving',
      (() => {
        const doc = new LoroDoc()
        const list = doc.getMovableList('elements')
        const map = list.insertContainer(0, new LoroMap())
        map.set('id', 'el-version-only')
        map.set('type', 'image')
        map.set('fileId', 'version-only')
        map.set('isDeleted', false)
        doc.commit()
        return doc
      })(),
    )
    const store = new FileVersionStore()
    await store.save('ws_v', 'evolving', await loadCanvas('ws_v', 'evolving'), { auto: false })

    const live = await loadCanvas('ws_v', 'evolving')
    const list = live.getMovableList('elements')
    if (list.length > 0) list.delete(0, list.length)
    live.commit()
    await saveCanvas('ws_v', 'evolving', live, { overwrite: true })

    const filesDir = join(tempDir, 'ws_v', 'files')
    await mkdir(filesDir, { recursive: true })
    await writeFile(join(filesDir, 'version-only.png'), Buffer.alloc(10, 1))
    // Age the file past the default grace window so this test isolates the
    // versionStore-wiring question from the unrelated grace-window guard --
    // a fresh file would survive either way and the mutation-check below
    // would not actually catch a dropped versionStore argument.
    const past = new Date(Date.now() - 2 * 60 * 60 * 1000)
    await import('node:fs/promises').then((m) =>
      m.utimes(join(filesDir, 'version-only.png'), past, past),
    )

    const sweeper = createFileGcSweeper({
      listWorkspaces: async () => [{ workspaceId: 'ws_v' }],
      discoverFsWorkspaces: async () => [],
    })
    await sweeper.tick()
    await sweeper.stop()

    const remaining = await import('node:fs/promises').then((m) => m.readdir(filesDir))
    // The version-only file must SURVIVE: it is referenced only by a saved
    // version, and the default purge fn must have been given a versionStore
    // that can see it.
    expect(remaining).toEqual(['version-only.png'])
  })
})

describe('discoverFsWorkspaces (default, via real filesystem)', () => {
  it('finds an upload-only workspace dir with no DB row and purges its dangling file after grace elapses', async () => {
    const filesDir = join(tempDir, 'ws_upload_only', 'files')
    await mkdir(filesDir, { recursive: true })
    await writeFile(join(filesDir, 'orphan.png'), Buffer.alloc(10, 2))
    // Age the file past the default grace window.
    const past = new Date(Date.now() - 2 * 60 * 60 * 1000)
    await import('node:fs/promises').then((m) => m.utimes(join(filesDir, 'orphan.png'), past, past))

    const sweeper = createFileGcSweeper({
      listWorkspaces: async () => [], // no DB row -- this workspace only exists on disk
    })
    await sweeper.tick()
    await sweeper.stop()

    const remaining = await import('node:fs/promises').then((m) => m.readdir(filesDir))
    expect(remaining).toEqual([])
  })

  it('skips a symlinked top-level entry and never touches files outside the data dir', async () => {
    const outsideDir = await mkdtemp(join(tmpdir(), 'whiteboard-sweeper-outside-'))
    try {
      const outsideFilesDir = join(outsideDir, 'files')
      await mkdir(outsideFilesDir, { recursive: true })
      await writeFile(join(outsideFilesDir, 'secret.png'), Buffer.alloc(10, 3))
      const past = new Date(Date.now() - 2 * 60 * 60 * 1000)
      await import('node:fs/promises').then((m) =>
        m.utimes(join(outsideFilesDir, 'secret.png'), past, past),
      )

      await symlink(outsideDir, join(tempDir, 'evil'), 'dir')

      const sweeper = createFileGcSweeper({
        listWorkspaces: async () => [],
      })
      await sweeper.tick()
      await sweeper.stop()

      const remaining = await import('node:fs/promises').then((m) => m.readdir(outsideFilesDir))
      expect(remaining).toEqual(['secret.png'])
    } finally {
      await rm(outsideDir, { recursive: true, force: true })
    }
  })

  it('skips the literal blobs dir', async () => {
    const blobsDir = join(tempDir, 'blobs')
    await mkdir(blobsDir, { recursive: true })
    const listWorkspaces = vi.fn(async () => [])
    const purge = vi.fn(async () => ({ purgedCount: 0, purgedBytes: 0 }))
    const sweeper = createFileGcSweeper({ listWorkspaces, purge })
    await sweeper.tick()
    await sweeper.stop()
    expect(purge).not.toHaveBeenCalledWith('blobs')
  })
})
