import {
  closeSync as closeSyncReal,
  mkdtempSync,
  openSync as openSyncReal,
  rmSync,
  writeSync as writeSyncReal,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  acquireSpawnLock,
  DEFAULT_SPAWN_LOCK_STALE_MS,
  isLockStale,
  releaseSpawnLock,
  resolveSpawnLockStaleMs,
} from './dev-spawn-lock-lib.mjs'
import { DEFAULT_READY_TIMEOUT_MS } from './ensure-http-dev-daemon-lib.mjs'

describe('resolveSpawnLockStaleMs', () => {
  it.each([
    ['absent', undefined],
    ['empty', ''],
    ['non-numeric', 'nope'],
    ['non-integer', '12.5'],
    ['zero', '0'],
    ['negative', '-1'],
  ])('falls back to the default when the override is %s', (_label, value) => {
    const env = value === undefined ? {} : { WHITEBOARD_DEV_SPAWN_LOCK_STALE_MS: value }
    expect(resolveSpawnLockStaleMs(env)).toBe(DEFAULT_SPAWN_LOCK_STALE_MS)
  })

  it('returns the parsed value for a valid positive integer override', () => {
    expect(resolveSpawnLockStaleMs({ WHITEBOARD_DEV_SPAWN_LOCK_STALE_MS: '1234' })).toBe(1234)
  })

  it('defaults strictly above the ready-timeout default so a slow cold start is never mistaken for a crashed holder', () => {
    expect(DEFAULT_SPAWN_LOCK_STALE_MS).toBeGreaterThan(DEFAULT_READY_TIMEOUT_MS)
  })
})

describe('isLockStale', () => {
  const isPidAlive = (pid: number) => pid === 1 // pid 1 = "alive" fixture, anything else "dead"

  it('is not stale for a live pid within the staleness window', () => {
    expect(
      isLockStale({
        meta: { pid: 1 },
        lockMtimeMs: 1_000,
        nowMs: 1_500,
        staleAfterMs: 10_000,
        isPidAlive,
      }),
    ).toBe(false)
  })

  it('is stale for a dead pid regardless of age', () => {
    expect(
      isLockStale({
        meta: { pid: 2 },
        lockMtimeMs: 1_000,
        nowMs: 1_001,
        staleAfterMs: 10_000,
        isPidAlive,
      }),
    ).toBe(true)
  })

  it('is stale for a live pid whose lock age exceeds the window', () => {
    expect(
      isLockStale({
        meta: { pid: 1 },
        lockMtimeMs: 0,
        nowMs: 20_000,
        staleAfterMs: 10_000,
        isPidAlive,
      }),
    ).toBe(true)
  })

  it('is not stale for missing/unparsable meta within the window (a lock just created by a racing process)', () => {
    expect(
      isLockStale({
        meta: null,
        lockMtimeMs: 1_000,
        nowMs: 1_500,
        staleAfterMs: 10_000,
        isPidAlive,
      }),
    ).toBe(false)
  })

  it('is stale for missing meta once the age exceeds the window', () => {
    expect(
      isLockStale({ meta: null, lockMtimeMs: 0, nowMs: 20_000, staleAfterMs: 10_000, isPidAlive }),
    ).toBe(true)
  })
})

describe('acquireSpawnLock / releaseSpawnLock (real temp dir)', () => {
  let dir: string
  let lockPath: string
  const isPidAlive = () => true

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dev-spawn-lock-'))
    lockPath = join(dir, 'dev-daemon-spawn.lock')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('acquires the lock on the first call and records our pid', () => {
    const result = acquireSpawnLock({
      lockPath,
      meta: { pid: process.pid },
      staleAfterMs: 10_000,
      isPidAlive,
    })
    expect(result).toBe('acquired')
  })

  it('returns held-by-other on an immediate second call from a live holder', () => {
    acquireSpawnLock({ lockPath, meta: { pid: process.pid }, staleAfterMs: 10_000, isPidAlive })
    const second = acquireSpawnLock({
      lockPath,
      meta: { pid: process.pid + 1 },
      staleAfterMs: 10_000,
      isPidAlive,
    })
    expect(second).toBe('held-by-other')
  })

  it('steals a lock whose recorded pid is dead', () => {
    acquireSpawnLock({
      lockPath,
      meta: { pid: 999_999 },
      staleAfterMs: 10_000,
      isPidAlive: () => false,
    })
    const stolen = acquireSpawnLock({
      lockPath,
      meta: { pid: process.pid },
      staleAfterMs: 10_000,
      isPidAlive: () => false,
    })
    expect(stolen).toBe('acquired')
  })

  it('returns held-by-other when a steal-retry loses to a concurrent EEXIST', () => {
    acquireSpawnLock({
      lockPath,
      meta: { pid: 999_999 },
      staleAfterMs: 10_000,
      isPidAlive: () => false,
    })
    const eexist = Object.assign(new Error('EEXIST'), { code: 'EEXIST' })
    const result = acquireSpawnLock({
      lockPath,
      meta: { pid: process.pid },
      staleAfterMs: 10_000,
      isPidAlive: () => false,
      fsOpen: () => {
        throw eexist
      },
    })
    expect(result).toBe('held-by-other')
  })

  it('never checks existence before creating: the injected open() is called first, with the wx flag', () => {
    const calls: string[] = []
    const result = acquireSpawnLock({
      lockPath,
      meta: { pid: process.pid },
      staleAfterMs: 10_000,
      isPidAlive,
      fsOpen: (path, flag) => {
        calls.push(`open:${flag}`)
        return openSyncReal(path, flag)
      },
      fsWrite: (fd, data) => {
        calls.push('write')
        return writeSyncReal(fd, data)
      },
      fsClose: (fd) => {
        calls.push('close')
        closeSyncReal(fd)
      },
    })
    expect(result).toBe('acquired')
    expect(calls[0]).toBe('open:wx')
  })

  it('degrades to held-by-other on an unexpected fs error instead of throwing', () => {
    const boom = new Error('boom')
    const result = acquireSpawnLock({
      lockPath,
      meta: { pid: process.pid },
      staleAfterMs: 10_000,
      isPidAlive,
      fsOpen: () => {
        throw boom
      },
    })
    expect(result).toBe('held-by-other')
  })

  it('releases a lock recording our own pid', () => {
    acquireSpawnLock({ lockPath, meta: { pid: process.pid }, staleAfterMs: 10_000, isPidAlive })
    releaseSpawnLock({ lockPath, ownerPid: process.pid })
    const reacquired = acquireSpawnLock({
      lockPath,
      meta: { pid: process.pid },
      staleAfterMs: 10_000,
      isPidAlive,
    })
    expect(reacquired).toBe('acquired')
  })

  it('leaves a lock recording a different pid untouched (never clobbers a successor)', () => {
    acquireSpawnLock({ lockPath, meta: { pid: 424_242 }, staleAfterMs: 10_000, isPidAlive })
    releaseSpawnLock({ lockPath, ownerPid: process.pid })
    const stillHeld = acquireSpawnLock({
      lockPath,
      meta: { pid: process.pid },
      staleAfterMs: 10_000,
      isPidAlive,
    })
    expect(stillHeld).toBe('held-by-other')
  })

  it('is a no-op (never throws) when the lock file is already gone', () => {
    expect(() => releaseSpawnLock({ lockPath, ownerPid: process.pid })).not.toThrow()
  })
})
