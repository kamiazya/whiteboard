import {
  closeSync as closeSyncReal,
  existsSync,
  mkdtempSync,
  openSync as openSyncReal,
  readdirSync,
  readFileSync,
  renameSync as renameSyncReal,
  rmSync,
  type statSync,
  unlinkSync as unlinkSyncReal,
  utimesSync,
  writeFileSync,
  writeSync as writeSyncReal,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  acquireSpawnLock,
  claimPidFile,
  DEFAULT_SPAWN_LOCK_STALE_MS,
  isLockStale,
  readPidFile,
  releasePidFile,
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
    expect(result).toEqual({ kind: 'acquired' })
  })

  it('returns held on an immediate second call from a live holder', () => {
    acquireSpawnLock({ lockPath, meta: { pid: process.pid }, staleAfterMs: 10_000, isPidAlive })
    const second = acquireSpawnLock({
      lockPath,
      meta: { pid: process.pid + 1 },
      staleAfterMs: 10_000,
      isPidAlive,
    })
    expect(second).toEqual({ kind: 'held', holderPid: process.pid })
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
    expect(stolen).toEqual({ kind: 'acquired' })
  })

  it('never lets a losing stealer clobber the winner: a failed atomic rename degrades to held without touching the winner lock (TOCTOU regression)', () => {
    acquireSpawnLock({
      lockPath,
      meta: { pid: 999_999 },
      staleAfterMs: 10_000,
      isPidAlive: () => false,
    })
    const winner = acquireSpawnLock({
      lockPath,
      meta: { pid: process.pid },
      staleAfterMs: 10_000,
      isPidAlive: () => false,
    })
    expect(winner).toEqual({ kind: 'acquired' })
    const winnerContent = readFileSync(lockPath, 'utf8')

    // Simulates a second stealer that inspected the same stale snapshot but
    // loses the atomic claim because the winner already renamed the file
    // out from under it: rename() fails with ENOENT, the classic signal
    // that the source path no longer exists.
    const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    const loser = acquireSpawnLock({
      lockPath,
      meta: { pid: 555 },
      staleAfterMs: 10_000,
      isPidAlive: () => false, // treats the (actually live) winner as dead too, forcing the loser down the steal path
      fsRename: () => {
        throw enoent
      },
    })

    expect(loser).toEqual({ kind: 'held', holderPid: process.pid })
    expect(readFileSync(lockPath, 'utf8')).toBe(winnerContent)
  })

  it.each([
    ['a newer mtime', new Date()],
    ['the same mtime', new Date(0)],
  ])('puts back a newer holder with %s a stealer moved by mistake, staying held', (_label, newerMtime) => {
    acquireSpawnLock({
      lockPath,
      meta: { pid: 999_999 },
      staleAfterMs: 10_000,
      isPidAlive: () => false,
    })
    utimesSync(lockPath, new Date(0), new Date(0))
    const fresh = JSON.stringify({ pid: 777 })
    const result = acquireSpawnLock({
      lockPath,
      meta: { pid: process.pid },
      staleAfterMs: 10_000,
      isPidAlive: () => false,
      // Between this stealer's judgement and its rename, another stealer took
      // the stale file away and created its own: the rename moves THAT one.
      fsRename: (from, to) => {
        renameSyncReal(from, `${String(from)}.other-stealer`)
        writeFileSync(from, fresh)
        utimesSync(from, newerMtime, newerMtime)
        renameSyncReal(from, to)
      },
    })
    expect(result).toEqual({ kind: 'held', holderPid: 777 })
    expect(readFileSync(lockPath, 'utf8')).toBe(fresh)
    expect(readdirSync(dir).filter((name) => name.includes('.stale-'))).toEqual([])
  })

  it('steals via an atomic rename() claim rather than a bare unlink+create', () => {
    acquireSpawnLock({
      lockPath,
      meta: { pid: 999_999 },
      staleAfterMs: 10_000,
      isPidAlive: () => false,
    })
    const calls: string[] = []
    const result = acquireSpawnLock({
      lockPath,
      meta: { pid: process.pid },
      staleAfterMs: 10_000,
      isPidAlive: () => false,
      fsRename: (from, to) => {
        calls.push('rename')
        renameSyncReal(from, to)
      },
    })
    expect(result).toEqual({ kind: 'acquired' })
    expect(calls).toEqual(['rename'])
  })

  it('returns held when a steal-retry loses to a concurrent EEXIST', () => {
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
    expect(result).toEqual({ kind: 'held', holderPid: null })
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
    expect(result).toEqual({ kind: 'acquired' })
    expect(calls[0]).toBe('open:wx')
  })

  it('degrades to held on an unexpected fs error instead of throwing', () => {
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
    expect(result).toEqual({ kind: 'held', holderPid: null })
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
    expect(reacquired).toEqual({ kind: 'acquired' })
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
    expect(stillHeld).toEqual({ kind: 'held', holderPid: 424_242 })
  })

  it.each([
    ['names no pid', JSON.stringify({ startedAt: 'x' })],
    ['is not JSON', 'not json'],
    ['names a pid that is no pid', JSON.stringify({ pid: -1 })],
    ['is empty', ''],
  ])('reports no holder pid for a live lock whose metadata %s', (_label, text) => {
    writeFileSync(lockPath, text)
    const result = acquireSpawnLock({
      lockPath,
      meta: { pid: process.pid },
      staleAfterMs: 10_000,
      isPidAlive,
    })
    expect(result).toEqual({ kind: 'held', holderPid: null })
  })

  // A crash between the exclusive create and the metadata write leaves an
  // empty file naming no pid, so its age is the only way it ever frees up.
  it('takes an empty lock file once it is older than the staleness window', () => {
    writeFileSync(lockPath, '')
    const result = acquireSpawnLock({
      lockPath,
      meta: { pid: process.pid },
      nowMs: Date.now() + 60_000,
      staleAfterMs: 10_000,
      isPidAlive,
    })
    expect(result).toEqual({ kind: 'acquired' })
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toEqual({ pid: process.pid })
  })

  it('is a no-op (never throws) when the lock file is already gone', () => {
    expect(() => releaseSpawnLock({ lockPath, ownerPid: process.pid })).not.toThrow()
  })
})

describe('claimPidFile / releasePidFile (real temp dir)', () => {
  let dir: string
  let pidPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dev-wrapper-pid-'))
    pidPath = join(dir, 'dev-wrapper.pid')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('creates the file holding the bare pid when none exists', () => {
    expect(claimPidFile({ pidPath, pid: 42, isWriterAlive: () => true })).toEqual({
      kind: 'claimed',
    })
    expect(readFileSync(pidPath, 'utf8')).toBe('42')
  })

  it('leaves a file whose writer is alive untouched, and names that writer', () => {
    writeFileSync(pidPath, '7')
    expect(claimPidFile({ pidPath, pid: 42, isWriterAlive: (pid) => pid === 7 })).toEqual({
      kind: 'held',
      pid: 7,
    })
    expect(readFileSync(pidPath, 'utf8')).toBe('7')
  })

  it('asks about the writer with the time the file was written', () => {
    writeFileSync(pidPath, '7')
    const seen: number[] = []
    claimPidFile({
      pidPath,
      pid: 42,
      isWriterAlive: (_pid, writtenAtMs) => {
        seen.push(writtenAtMs)
        return true
      },
    })
    expect(seen).toHaveLength(1)
    expect(Math.abs((seen[0] as number) - Date.now())).toBeLessThan(60_000)
  })

  it.each([
    ['a dead writer', '7'],
    ['unparsable content', 'not-a-pid'],
  ])('replaces a file left by %s', (_label, content) => {
    writeFileSync(pidPath, content)
    expect(claimPidFile({ pidPath, pid: 42, isWriterAlive: () => false })).toEqual({
      kind: 'claimed',
    })
    expect(readFileSync(pidPath, 'utf8')).toBe('42')
  })

  it('replaces a stale file through a rename claim and leaves no claim copy behind', () => {
    writeFileSync(pidPath, '7')
    const calls: string[] = []
    const result = claimPidFile({
      pidPath,
      pid: 42,
      isWriterAlive: () => false,
      fsRename: (from, to) => {
        calls.push('rename')
        renameSyncReal(from, to)
      },
      fsUnlink: (path) => {
        calls.push(String(path).includes('.stale-') ? 'unlink claim copy' : 'unlink pid file')
        unlinkSyncReal(path)
      },
    })
    expect(result).toEqual({ kind: 'claimed' })
    expect(calls).toEqual(['rename', 'unlink claim copy'])
    expect(readdirSync(dir)).toEqual(['dev-wrapper.pid'])
    expect(readFileSync(pidPath, 'utf8')).toBe('42')
  })

  it('a stealer losing the rename claim leaves the winner file alone and names it', () => {
    writeFileSync(pidPath, '7')
    // ENOENT from rename() is what a second stealer sees once the first has
    // already moved the stale file away.
    const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    const result = claimPidFile({
      pidPath,
      pid: 42,
      isWriterAlive: () => false,
      fsRename: () => {
        throw enoent
      },
    })
    expect(result).toEqual({ kind: 'held', pid: 7 })
    expect(readFileSync(pidPath, 'utf8')).toBe('7')
  })

  it.each([
    ['0'],
    ['-3'],
    ['1.5'],
    ['abc'],
  ])('replaces a file naming %s without asking whether it is alive', (content) => {
    writeFileSync(pidPath, content)
    const asked: number[] = []
    const result = claimPidFile({
      pidPath,
      pid: 42,
      isWriterAlive: (pid) => {
        asked.push(pid)
        return true
      },
    })
    expect(asked).toEqual([])
    expect(result).toEqual({ kind: 'claimed' })
    expect(readFileSync(pidPath, 'utf8')).toBe('42')
  })

  it('a create error other than EEXIST is held without reading the existing file', () => {
    writeFileSync(pidPath, '7')
    const eacces = Object.assign(new Error('EACCES'), { code: 'EACCES' })
    let read = false
    const result = claimPidFile({
      pidPath,
      pid: 42,
      isWriterAlive: () => false,
      fsOpen: () => {
        throw eacces
      },
      fsReadFile: ((path: string, encoding: BufferEncoding) => {
        read = true
        return readFileSync(path, encoding)
      }) as typeof readFileSync,
    })
    expect(result).toEqual({ kind: 'held', pid: null })
    expect(read).toBe(false)
    expect(readFileSync(pidPath, 'utf8')).toBe('7')
  })

  it('an unreadable pid file counts as held, not as free', () => {
    writeFileSync(pidPath, '7')
    const eacces = Object.assign(new Error('EACCES'), { code: 'EACCES' })
    const result = claimPidFile({
      pidPath,
      pid: 42,
      isWriterAlive: () => false,
      fsReadFile: (() => {
        throw eacces
      }) as typeof readFileSync,
    })
    expect(result).toEqual({ kind: 'held', pid: null })
    expect(readFileSync(pidPath, 'utf8')).toBe('7')
  })

  it('a pid file whose stat fails is held, not stolen', () => {
    writeFileSync(pidPath, '7')
    const result = claimPidFile({
      pidPath,
      pid: 42,
      isWriterAlive: () => false,
      fsStat: (() => {
        throw Object.assign(new Error('EIO'), { code: 'EIO' })
      }) as typeof statSync,
    })
    expect(result).toEqual({ kind: 'held', pid: 7 })
    expect(readFileSync(pidPath, 'utf8')).toBe('7')
  })

  it('removes the file only while it names the releasing pid', () => {
    writeFileSync(pidPath, '7')
    releasePidFile({ pidPath, pid: 42 })
    expect(readFileSync(pidPath, 'utf8')).toBe('7')
    releasePidFile({ pidPath, pid: 7 })
    expect(existsSync(pidPath)).toBe(false)
  })

  it('treats an absent file as already released', () => {
    expect(() => releasePidFile({ pidPath, pid: 42 })).not.toThrow()
  })

  it('reads back the pid a file names with the time it was written', () => {
    writeFileSync(pidPath, '7')
    utimesSync(pidPath, 1_700_000_000, 1_700_000_000)
    expect(readPidFile(pidPath)).toEqual({ pid: 7, writtenAtMs: 1_700_000_000_000 })
  })

  it.each([
    ['absent', null],
    ['empty', ''],
    ['naming no pid', 'not-a-pid'],
  ])('reads a pid file that is %s as none', (_label, content) => {
    if (content !== null) writeFileSync(pidPath, content)
    expect(readPidFile(pidPath)).toBeNull()
  })
})
