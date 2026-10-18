/**
 * ADR-0050 decision 2: the daemon listens on a local socket that only its
 * owner can open. Where that socket lives, and refusing a place someone else
 * could have prepared, is what this module decides.
 */
import {
  chmodSync,
  chownSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from 'vitest'
import { ROOT_IS_SOMEONE_ELSES } from '../shared/test-utils/root-is-someone-elses.js'
import {
  clearStaleSocket,
  daemonSocketPath,
  listenOnSocket,
  prepareSocketDirectory,
  socketTrust,
} from './daemon-socket.js'

let scratch: string
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'wb-socket-'))
})
afterEach(() => rmSync(scratch, { recursive: true, force: true }))

// Probed rather than inferred from getuid(): whether this process may hand a
// directory to another uid is decided by capabilities, not by being root.
const CAN_CHOWN_AWAY: boolean = (() => {
  const probe = mkdtempSync(join(tmpdir(), 'wb-chown-probe-'))
  try {
    chownSync(probe, 12345, 12345)
    return process.getuid?.() !== 12345
  } catch {
    return false
  } finally {
    rmSync(probe, { recursive: true, force: true })
  }
})()

describe('daemonSocketPath', () => {
  it('lives under the per-user runtime directory, one socket per data dir', () => {
    const env = { XDG_RUNTIME_DIR: '/run/user/1000' }
    const a = daemonSocketPath('/home/ada/.whiteboard', { env, platform: 'linux', uid: 1000 })
    const b = daemonSocketPath('/home/ada/project/.dev-data', { env, platform: 'linux', uid: 1000 })
    expect(a).toMatch(/^\/run\/user\/1000\/whiteboard\/[0-9a-f]{16}\.sock$/)
    expect(b).not.toBe(a)
    expect(daemonSocketPath('/home/ada/.whiteboard', { env, platform: 'linux', uid: 1000 })).toBe(a)
  })

  it('falls back to a per-user directory under the temp dir without a runtime dir', () => {
    const path = daemonSocketPath('/home/ada/.whiteboard', {
      env: {},
      platform: 'linux',
      uid: 1000,
      tmp: '/tmp',
    })
    expect(path).toMatch(/^\/tmp\/whiteboard-1000\/[0-9a-f]{16}\.sock$/)
  })

  // A Unix socket path is limited to 104 bytes on macOS and 108 on Linux; a
  // path derived from a deep data dir would otherwise fail to bind.
  it('stays short however deep the data dir is', () => {
    const deep = `/home/ada/${'nested/'.repeat(40)}.whiteboard`
    const path = daemonSocketPath(deep, {
      env: { XDG_RUNTIME_DIR: '/run/user/1000' },
      platform: 'linux',
      uid: 1000,
    })
    expect(path?.length).toBeLessThan(104)
  })

  // ADR-0050 decision 9. A pipe has no directory to close, so another user
  // could create one first under a name they can predict and receive the
  // token the host sends. The name is random instead, and only the owner's
  // daemon record says it.
  it('is a named pipe on Windows, under a name nobody can predict', () => {
    const context = { env: {}, platform: 'win32' as const, uid: -1 }
    const first = daemonSocketPath('C:\\wb', context)
    const second = daemonSocketPath('C:\\wb', context)
    expect(first).toMatch(/^\\\\\.\\pipe\\whiteboard-[0-9a-f]{32}$/)
    expect(second).not.toBe(first)
  })
})

describe('prepareSocketDirectory', () => {
  it('creates the directory owner-only', () => {
    const dir = join(scratch, 'whiteboard')
    prepareSocketDirectory(dir)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
  })

  // Under a shared temp dir another user could create the directory first
  // and later swap the socket inside it.
  it('refuses a directory that others can reach into', () => {
    const dir = join(scratch, 'whiteboard')
    mkdirSync(dir)
    chmodSync(dir, 0o755)
    expect(() => prepareSocketDirectory(dir)).toThrow(/owner-only/)
  })

  // lstat, not stat: a link to an owner-only directory would otherwise pass
  // both checks while the socket landed wherever the link points.
  it('refuses a symlink standing where the directory should be, even one aimed at an owner-only directory', () => {
    const real = join(scratch, 'real')
    mkdirSync(real, { mode: 0o700 })
    const link = join(scratch, 'link')
    symlinkSync(real, link)
    expect(() => prepareSocketDirectory(link)).toThrow(/not a directory this user owns/)
  })

  it.skipIf(!CAN_CHOWN_AWAY)('refuses an owner-only directory that belongs to another uid', () => {
    const dir = join(scratch, 'theirs')
    mkdirSync(dir, { mode: 0o700 })
    chownSync(dir, 12345, 12345)
    expect(() => prepareSocketDirectory(dir)).toThrow(/not a directory this user owns/)
  })

  it.skipIf(!ROOT_IS_SOMEONE_ELSES)(
    'refuses a directory owned by root when this user is not root',
    () => {
      expect(() => prepareSocketDirectory('/')).toThrow(/not a directory this user owns/)
    },
  )
})

describe('socketTrust', () => {
  const UID = process.getuid?.() ?? 0

  async function listeningIn(dir: string): Promise<string> {
    mkdirSync(dir, { mode: 0o700 })
    const path = join(dir, 'd.sock')
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(path, () => resolve()))
    onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())))
    return path
  }

  /** The real lstat, with `path`'s owner swapped: what another user's file looks like. */
  function ownedBy(path: string, uid: number) {
    return (asked: string) => {
      const stat = lstatSync(asked)
      return asked === path
        ? Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { uid })
        : stat
    }
  }

  it('finds nothing against a socket of its own in an owner-only directory', async () => {
    const path = await listeningIn(join(scratch, 'own'))
    expect(socketTrust(path, { uid: UID })).toEqual({ kind: 'trusted' })
  })

  it('finds nothing against a missing socket in an owner-only directory of its own', () => {
    mkdirSync(join(scratch, 'empty'), { mode: 0o700 })
    expect(socketTrust(join(scratch, 'empty', 'd.sock'), { uid: UID })).toEqual({ kind: 'trusted' })
  })

  // Another user can swap a directory they own between the check and the
  // connect, so a missing socket says nothing until its directory is checked.
  it('refuses a missing socket whose directory another uid owns', () => {
    mkdirSync(join(scratch, 'swapped'), { mode: 0o700 })
    const path = join(scratch, 'swapped', 'd.sock')
    const lstat = ownedBy(dirname(path), UID + 1)
    expect(socketTrust(path, { uid: UID, lstat })).toMatchObject({
      kind: 'refused',
      // Names the way out: a socket directory of the user's own.
      reason: expect.stringMatching(/not a directory this user owns.*XDG_RUNTIME_DIR.*TMPDIR/),
    })
  })

  it('does not trust a socket whose directory does not exist', () => {
    expect(socketTrust(join(scratch, 'missing', 'd.sock'))).toEqual({ kind: 'absent' })
  })

  it('refuses a socket in a directory others can enter', async () => {
    const path = await listeningIn(join(scratch, 'open'))
    chmodSync(dirname(path), 0o755)
    expect(socketTrust(path, { uid: UID })).toMatchObject({
      kind: 'refused',
      reason: expect.stringMatching(/owner-only/),
    })
  })

  it('refuses a socket whose closed directory another uid owns', async () => {
    const path = await listeningIn(join(scratch, 'theirs'))
    const lstat = ownedBy(dirname(path), UID + 1)
    expect(socketTrust(path, { uid: UID, lstat })).toMatchObject({
      kind: 'refused',
      reason: expect.stringMatching(/not a directory this user owns/),
    })
  })

  it('refuses a socket another uid owns inside a closed directory of its own', async () => {
    const path = await listeningIn(join(scratch, 'planted'))
    const lstat = ownedBy(path, UID + 1)
    expect(socketTrust(path, { uid: UID, lstat })).toMatchObject({
      kind: 'refused',
      reason: expect.stringMatching(/not owned by this user/),
    })
  })

  it('refuses a symlink standing at the socket path', () => {
    mkdirSync(join(scratch, 'linked'), { mode: 0o700 })
    const path = join(scratch, 'linked', 'd.sock')
    symlinkSync(join(scratch, 'elsewhere.sock'), path)
    expect(socketTrust(path)).toMatchObject({
      kind: 'refused',
      reason: expect.stringMatching(/symbolic link/),
    })
  })
})

describe('clearStaleSocket', () => {
  it('removes a socket file nothing answers on', async () => {
    const path = join(scratch, 'stale.sock')
    writeFileSync(path, '')
    await clearStaleSocket(path)
    expect(existsSync(path)).toBe(false)
  })

  it('refuses to remove a socket another daemon is listening on', async () => {
    const path = join(scratch, 'live.sock')
    const live = createServer()
    await new Promise<void>((resolve) => live.listen(path, resolve))
    try {
      await expect(clearStaleSocket(path)).rejects.toThrow(/already listening/)
      expect(existsSync(path)).toBe(true)
    } finally {
      await new Promise<void>((resolve) => live.close(() => resolve()))
    }
  })
})

describe('listenOnSocket', () => {
  const ok = () => new Response('ok')

  it('serves on a path that fits and unlinks it on close', async () => {
    const path = join(scratch, 'whiteboard', 'fits.sock')
    const listener = await listenOnSocket(ok, path)
    expect(existsSync(path)).toBe(true)
    await listener.close()
    expect(existsSync(path)).toBe(false)
  })

  // The kernel would otherwise truncate the name at bind and the daemon would
  // fail later on a path that exists nowhere, with an error about chmod.
  it('refuses, before making anything, a path longer than a unix socket can name', async () => {
    const dir = join(scratch, 'x'.repeat(200))
    const path = join(dir, 'whiteboard', 'long.sock')
    const refusal = await listenOnSocket(ok, path).then(
      () => null,
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    )
    expect(refusal).toMatch(/bytes/)
    expect(refusal).toMatch(/XDG_RUNTIME_DIR/)
    expect(refusal).toMatch(/TMPDIR/)
    expect(existsSync(dir)).toBe(false)
  })
})

describe('listenOnSocket path-length ceiling', () => {
  const limit = process.platform === 'darwin' ? 103 : 107
  const pathOfBytes = (bytes: number) => {
    const prefix = join(scratch, 'w', '')
    return `${prefix}${'s'.repeat(bytes - Buffer.byteLength(prefix) - '.sock'.length)}.sock`
  }

  it(`binds a path of exactly ${limit} bytes`, async () => {
    const path = pathOfBytes(limit)
    expect(Buffer.byteLength(path)).toBe(limit)
    const listener = await listenOnSocket(() => new Response('ok'), path)
    expect(existsSync(path)).toBe(true)
    await listener.close()
  })

  it(`refuses a path of ${limit + 1} bytes, naming the limit`, async () => {
    const path = pathOfBytes(limit + 1)
    await expect(listenOnSocket(() => new Response('ok'), path)).rejects.toThrow(
      new RegExp(`over the ${limit}-byte limit`),
    )
  })
})
