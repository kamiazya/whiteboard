import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as realSetImmediate } from 'node:timers'
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

// Lets tests inject a one-off, path-scoped rejection from lstat/realpath to
// exercise isDbWorkspaceDirSafe's generic (non-ENOENT) failure branches,
// which a real filesystem can't reliably reproduce (permission checks are
// bypassed for the root user, which many CI containers run as). Every path
// not matching the override falls through to the real implementation.
const { fsFailureOverrides } = vi.hoisted(() => ({
  fsFailureOverrides: {
    lstat: null as null | { path: string; err: unknown },
    realpath: null as null | { path: string; err: unknown },
  },
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    lstat: (path: Parameters<typeof actual.lstat>[0], ...rest: unknown[]) => {
      const override = fsFailureOverrides.lstat
      if (override && path === override.path) return Promise.reject(override.err)
      return (actual.lstat as (...args: unknown[]) => unknown)(path, ...rest)
    },
    realpath: (path: Parameters<typeof actual.realpath>[0], ...rest: unknown[]) => {
      const override = fsFailureOverrides.realpath
      if (override && path === override.path) return Promise.reject(override.err)
      return (actual.realpath as (...args: unknown[]) => unknown)(path, ...rest)
    },
  }
})

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
  fsFailureOverrides.lstat = null
  fsFailureOverrides.realpath = null
  await handle.dispose()
  await rm(tempDir, { recursive: true, force: true })
})

// vi.advanceTimersByTimeAsync() fast-forwards the fake JS clock and flushes
// the microtasks that produces, but runPass() now also awaits real
// (libuv-backed) fs.promises calls -- the DB-workspace containment check's
// lstat/realpath -- which fake timers cannot fast-forward or see, and which
// only settle once the real event loop actually turns. process.nextTick()
// alone is not enough (it never yields to libuv's poll/check phases); the
// real node:timers setImmediate captured above -- unaffected by
// vi.useFakeTimers(), which only patches globalThis -- forces genuine
// event-loop turns so pending fs completions land before assertions run.
async function advanceTimersAndFlush(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  await flushRealAsync()
}

// Same real-event-loop-turn flush as advanceTimersAndFlush(), for call sites
// that race tick() directly instead of going through the fake-timer clock.
async function flushRealAsync(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise<void>((resolve) => realSetImmediate(resolve))
  }
}

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
    await advanceTimersAndFlush(999)
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
    await advanceTimersAndFlush(1000)
    expect(purge).toHaveBeenCalledTimes(1)
    expect(purge).toHaveBeenCalledWith('ws_a')

    await advanceTimersAndFlush(1000)
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
    await advanceTimersAndFlush(10 * 24 * 60 * 60 * 1000)
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
    await advanceTimersAndFlush(1000)
    expect(purgeCalls).toBe(1)

    // Advance several more intervals while the first pass's purge is still
    // pending -- a naive implementation without a single-flight guard would
    // fire a new pass on every elapsed interval.
    await advanceTimersAndFlush(1000)
    await advanceTimersAndFlush(1000)
    await advanceTimersAndFlush(1000)
    expect(purgeCalls).toBe(1)

    d.resolve({ purgedCount: 0, purgedBytes: 0 })
    // Let the pass's .finally() run and reschedule.
    await Promise.resolve()
    await Promise.resolve()

    await advanceTimersAndFlush(1000)
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
    // Let the pass's discovery (listWorkspaces/discoverFsWorkspaces), its DB
    // workspace containment check, and its purge call resolve their
    // microtasks before the second tick() races in.
    await flushRealAsync()
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
    await advanceTimersAndFlush(10_000)
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
    await advanceTimersAndFlush(1000)

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

  it('resolves once timeoutMs elapses even though the in-flight pass has not settled', async () => {
    const d = deferred<{ purgedCount: number; purgedBytes: number }>()
    const purge = vi.fn(async () => d.promise)
    const sweeper = createFileGcSweeper({
      intervalMs: 1000,
      listWorkspaces: async () => [{ workspaceId: 'ws_a' }],
      discoverFsWorkspaces: async () => [],
      purge,
    })
    sweeper.start()
    await advanceTimersAndFlush(1000)

    let stopped = false
    const stopPromise = sweeper.stop({ timeoutMs: 5000 }).then(() => {
      stopped = true
    })
    await advanceTimersAndFlush(4999)
    expect(stopped).toBe(false)

    await advanceTimersAndFlush(1)
    await stopPromise
    expect(stopped).toBe(true)

    // The pass itself was never cancelled -- resolving it afterward must
    // not throw or reschedule (stopped=true already suppresses that).
    d.resolve({ purgedCount: 0, purgedBytes: 0 })
  })

  it('clears the timeoutMs race timer once the in-flight pass finishes normally (no leaked timer)', async () => {
    const d = deferred<{ purgedCount: number; purgedBytes: number }>()
    const purge = vi.fn(async () => d.promise)
    const sweeper = createFileGcSweeper({
      intervalMs: 1000,
      listWorkspaces: async () => [{ workspaceId: 'ws_a' }],
      discoverFsWorkspaces: async () => [],
      purge,
    })
    sweeper.start()
    await advanceTimersAndFlush(1000)

    const stopPromise = sweeper.stop({ timeoutMs: 5000 })
    d.resolve({ purgedCount: 0, purgedBytes: 0 })
    await stopPromise

    // stopped=true suppresses scheduleNext(), so the only timer that could
    // still be pending here is a leaked stop() race timeout -- without
    // clearing it, this stays 1 until the full 5000ms elapses.
    expect(vi.getTimerCount()).toBe(0)
  })

  it('still resolves promptly via timeoutMs when there is no in-flight pass to wait for', async () => {
    const purge = vi.fn(async () => ({ purgedCount: 0, purgedBytes: 0 }))
    const sweeper = createFileGcSweeper({
      intervalMs: 1000,
      listWorkspaces: async () => [],
      discoverFsWorkspaces: async () => [],
      purge,
    })
    await sweeper.stop({ timeoutMs: 5000 })
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
    await advanceTimersAndFlush(24 * 60 * 60 * 1000 - 1)
    expect(purge).not.toHaveBeenCalled()
    await advanceTimersAndFlush(1)
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
    await advanceTimersAndFlush(2000)
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
    await advanceTimersAndFlush(10 * 24 * 60 * 60 * 1000)
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
    await advanceTimersAndFlush(500)
    expect(purge).toHaveBeenCalledTimes(1)
    await sweeper.stop()
  })

  it("clamps an explicit intervalMs above setTimeout()'s max delay to that max, not the raw value", async () => {
    // Node truncates any setTimeout() delay beyond 2_147_483_647ms to 1ms
    // rather than throwing, so a naive pass-through of a value above that
    // ceiling (e.g. a plausible "every 30 days" setting) would fire almost
    // continuously instead of on the intended cadence.
    const MAX_TIMER_DELAY_MS = 2_147_483_647
    const overflowMs = 3_000_000_000
    const purge = vi.fn(async () => ({ purgedCount: 0, purgedBytes: 0 }))
    const sweeper = createFileGcSweeper({
      intervalMs: overflowMs,
      listWorkspaces: async () => [{ workspaceId: 'ws_a' }],
      discoverFsWorkspaces: async () => [],
      purge,
    })
    sweeper.start()
    await advanceTimersAndFlush(MAX_TIMER_DELAY_MS - 1)
    expect(purge).not.toHaveBeenCalled()
    await advanceTimersAndFlush(1)
    expect(purge).toHaveBeenCalledTimes(1)
    await sweeper.stop()
  })

  it('falls back to the 24h default when an explicit intervalMs is NaN', async () => {
    // typeof NaN === 'number', so a naive `typeof explicit === 'number'`
    // guard would let it through: Math.max(0, NaN) / Math.min(NaN, MAX) both
    // evaluate to NaN, and scheduleNext()'s `intervalMs <= 0` check does not
    // short-circuit on NaN, arming setTimeout(fn, NaN) -- which Node
    // coerces to a ~1ms delay instead of the intended disable/no-op.
    const purge = vi.fn(async () => ({ purgedCount: 0, purgedBytes: 0 }))
    const sweeper = createFileGcSweeper({
      intervalMs: Number.NaN,
      listWorkspaces: async () => [{ workspaceId: 'ws_a' }],
      discoverFsWorkspaces: async () => [],
      purge,
    })
    sweeper.start()
    await advanceTimersAndFlush(24 * 60 * 60 * 1000 - 1)
    expect(purge).not.toHaveBeenCalled()
    await advanceTimersAndFlush(1)
    expect(purge).toHaveBeenCalledTimes(1)
    await sweeper.stop()
  })

  it("clamps an env-provided interval above setTimeout()'s max delay to that max", async () => {
    const MAX_TIMER_DELAY_MS = 2_147_483_647
    process.env[ENV_KEY] = String(3_000_000_000)
    const purge = vi.fn(async () => ({ purgedCount: 0, purgedBytes: 0 }))
    const sweeper = createFileGcSweeper({
      listWorkspaces: async () => [{ workspaceId: 'ws_a' }],
      discoverFsWorkspaces: async () => [],
      purge,
    })
    sweeper.start()
    await advanceTimersAndFlush(MAX_TIMER_DELAY_MS - 1)
    expect(purge).not.toHaveBeenCalled()
    await advanceTimersAndFlush(1)
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
      await advanceTimersAndFlush(1000)
      expect(purge).not.toHaveBeenCalled()
      const errRecords = cap.records.filter(
        (r) => r.scope === 'file-gc-sweeper' && r.level === 'error',
      )
      expect(errRecords.length).toBeGreaterThan(0)

      // Next interval, discovery succeeds -- proves the failed pass still
      // rescheduled the next one instead of getting stuck.
      shouldFail = false
      await advanceTimersAndFlush(1000)
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

  it('skips a DB-listed workspace whose directory is a symlink escaping the data dir', async () => {
    const outsideDir = await mkdtemp(join(tmpdir(), 'whiteboard-sweeper-db-outside-'))
    try {
      const outsideFilesDir = join(outsideDir, 'files')
      await mkdir(outsideFilesDir, { recursive: true })
      await writeFile(join(outsideFilesDir, 'secret.png'), Buffer.alloc(10, 4))
      const past = new Date(Date.now() - 2 * 60 * 60 * 1000)
      await import('node:fs/promises').then((m) =>
        m.utimes(join(outsideFilesDir, 'secret.png'), past, past),
      )

      // The workspace's directory is a symlink pointing outside the data
      // dir, but the DB still lists it as a workspace -- unlike the
      // filesystem-discovery path, this is not filtered by
      // discoverFsWorkspaces()'s own containment check.
      await symlink(outsideDir, join(tempDir, 'evil_db_ws'), 'dir')

      const purge = vi.fn(async () => ({ purgedCount: 0, purgedBytes: 0 }))
      const sweeper = createFileGcSweeper({
        listWorkspaces: async () => [{ workspaceId: 'evil_db_ws' }],
        discoverFsWorkspaces: async () => [],
        purge,
      })
      await sweeper.tick()
      await sweeper.stop()

      expect(purge).not.toHaveBeenCalledWith('evil_db_ws')
      const remaining = await import('node:fs/promises').then((m) => m.readdir(outsideFilesDir))
      expect(remaining).toEqual(['secret.png'])
    } finally {
      await rm(outsideDir, { recursive: true, force: true })
    }
  })

  it('skips the blobs dir when it only holds canvas snapshots (no files/ child)', async () => {
    // canvas-store.ts's snapshot layout is <dataDir>/blobs/<workspaceId>/canvas/...
    // -- no files/ child of its own -- so the shared discovery containment
    // check already excludes it without a name-based special case.
    const blobsDir = join(tempDir, 'blobs', 'some_other_ws', 'canvas')
    await mkdir(blobsDir, { recursive: true })
    const listWorkspaces = vi.fn(async () => [])
    const purge = vi.fn(async () => ({ purgedCount: 0, purgedBytes: 0 }))
    const sweeper = createFileGcSweeper({ listWorkspaces, purge })
    await sweeper.tick()
    await sweeper.stop()
    expect(purge).not.toHaveBeenCalledWith('blobs')
  })

  it('sweeps an upload-only workspace literally named "blobs" that has a files/ dir', async () => {
    // 'blobs' is a valid workspace id and the upload route can write to
    // <dataDir>/blobs/files before any canvas ever creates a DB row for it
    // -- this is exactly the upload-only-workspace case the sweeper exists
    // to cover, and it must not be excluded just because the name is
    // 'blobs'.
    const filesDir = join(tempDir, 'blobs', 'files')
    await mkdir(filesDir, { recursive: true })
    await writeFile(join(filesDir, 'orphan.png'), Buffer.alloc(10, 6))
    const past = new Date(Date.now() - 2 * 60 * 60 * 1000)
    await import('node:fs/promises').then((m) => m.utimes(join(filesDir, 'orphan.png'), past, past))

    const sweeper = createFileGcSweeper({
      listWorkspaces: async () => [],
    })
    await sweeper.tick()
    await sweeper.stop()

    const remaining = await import('node:fs/promises').then((m) => m.readdir(filesDir))
    expect(remaining).toEqual([])
  })

  it('skips a DB-listed workspace whose top-level dir is safe but files/ is a symlink escaping the data dir', async () => {
    const outsideDir = await mkdtemp(join(tmpdir(), 'whiteboard-sweeper-db-files-outside-'))
    try {
      await writeFile(join(outsideDir, 'secret.png'), Buffer.alloc(10, 5))
      const past = new Date(Date.now() - 2 * 60 * 60 * 1000)
      await import('node:fs/promises').then((m) =>
        m.utimes(join(outsideDir, 'secret.png'), past, past),
      )

      // The workspace's own top-level dir is a real, non-symlinked directory
      // (so it passes isDbWorkspaceDirSafe's first containment check on its
      // own), but its files/ CHILD is a symlink pointing outside the data
      // dir. purgeDanglingFiles() only lexically joins <dir>/files and
      // follows whatever that resolves to.
      const workspaceDir = join(tempDir, 'ws_files_symlink')
      await mkdir(workspaceDir, { recursive: true })
      await symlink(outsideDir, join(workspaceDir, 'files'), 'dir')

      const purge = vi.fn(async () => ({ purgedCount: 0, purgedBytes: 0 }))
      const sweeper = createFileGcSweeper({
        listWorkspaces: async () => [{ workspaceId: 'ws_files_symlink' }],
        discoverFsWorkspaces: async () => [],
        purge,
      })
      await sweeper.tick()
      await sweeper.stop()

      expect(purge).not.toHaveBeenCalledWith('ws_files_symlink')
      const remaining = await import('node:fs/promises').then((m) => m.readdir(outsideDir))
      expect(remaining).toEqual(['secret.png'])
    } finally {
      await rm(outsideDir, { recursive: true, force: true })
    }
  })
})

describe('createFileGcSweeper per-workspace containment revalidation', () => {
  it('skips a later workspace whose dir was swapped for a symlink after discovery but before its own purge turn', async () => {
    // Both workspaces pass containment at discovery time. Processing
    // ws_first (which happens first -- fsWorkspaces order is preserved
    // into the purge loop) swaps ws_second's directory for a symlink
    // escaping the data dir, simulating another process racing the
    // sweeper mid-pass. Without revalidating immediately before each
    // purge call, ws_second's one-time discovery-time check would be
    // stale by the time its turn comes.
    const outsideDir = await mkdtemp(join(tmpdir(), 'whiteboard-sweeper-race-outside-'))
    try {
      const outsideFilesDir = join(outsideDir, 'files')
      await mkdir(outsideFilesDir, { recursive: true })
      await writeFile(join(outsideFilesDir, 'secret.png'), Buffer.alloc(10, 7))

      await mkdir(join(tempDir, 'ws_first', 'files'), { recursive: true })
      await mkdir(join(tempDir, 'ws_second', 'files'), { recursive: true })

      const purge = vi.fn(async (workspaceId: string) => {
        if (workspaceId === 'ws_first') {
          await rm(join(tempDir, 'ws_second'), { recursive: true, force: true })
          await symlink(outsideDir, join(tempDir, 'ws_second'), 'dir')
        }
        return { purgedCount: 0, purgedBytes: 0 }
      })

      const sweeper = createFileGcSweeper({
        listWorkspaces: async () => [],
        discoverFsWorkspaces: async () => ['ws_first', 'ws_second'],
        purge,
      })
      await sweeper.tick()
      await sweeper.stop()

      expect(purge).toHaveBeenCalledWith('ws_first')
      expect(purge).not.toHaveBeenCalledWith('ws_second')
    } finally {
      await rm(outsideDir, { recursive: true, force: true })
    }
  })
})

describe('isDbWorkspaceDirSafe generic (non-ENOENT) stat/realpath failures', () => {
  it('fails closed and logs a warning when stat rejects with a permission error', async () => {
    const cap = captureLogsForTests('debug')
    try {
      const workspaceDir = join(tempDir, 'ws_locked')
      await mkdir(workspaceDir, { recursive: true })
      const boom = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
      fsFailureOverrides.lstat = { path: workspaceDir, err: boom }

      const purge = vi.fn(async () => ({ purgedCount: 0, purgedBytes: 0 }))
      const sweeper = createFileGcSweeper({
        listWorkspaces: async () => [{ workspaceId: 'ws_locked' }],
        discoverFsWorkspaces: async () => [],
        purge,
      })
      await sweeper.tick()
      await sweeper.stop()

      expect(purge).not.toHaveBeenCalledWith('ws_locked')
      const warnRecords = cap.records.filter(
        (r) => r.scope === 'file-gc-sweeper' && r.level === 'warning',
      )
      expect(
        warnRecords.some(
          (r) =>
            r.data?.workspaceId === 'ws_locked' &&
            String((r.data?.err as Error | undefined)?.message).includes('EACCES'),
        ),
      ).toBe(true)
    } finally {
      cap.restore()
    }
  })

  it('fails closed and logs a warning when realpath rejects with a non-ENOENT error', async () => {
    const cap = captureLogsForTests('debug')
    try {
      const workspaceDir = join(tempDir, 'ws_unresolvable')
      await mkdir(workspaceDir, { recursive: true })
      const boom = Object.assign(new Error('EIO: i/o error'), { code: 'EIO' })
      fsFailureOverrides.realpath = { path: workspaceDir, err: boom }

      const purge = vi.fn(async () => ({ purgedCount: 0, purgedBytes: 0 }))
      const sweeper = createFileGcSweeper({
        listWorkspaces: async () => [{ workspaceId: 'ws_unresolvable' }],
        discoverFsWorkspaces: async () => [],
        purge,
      })
      await sweeper.tick()
      await sweeper.stop()

      expect(purge).not.toHaveBeenCalledWith('ws_unresolvable')
      const warnRecords = cap.records.filter(
        (r) => r.scope === 'file-gc-sweeper' && r.level === 'warning',
      )
      expect(
        warnRecords.some(
          (r) =>
            r.data?.workspaceId === 'ws_unresolvable' &&
            String((r.data?.err as Error | undefined)?.message).includes('EIO'),
        ),
      ).toBe(true)
    } finally {
      cap.restore()
    }
  })
})
