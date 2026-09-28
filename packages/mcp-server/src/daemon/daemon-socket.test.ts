/**
 * ADR-0050 decision 2: the daemon listens on a local socket that only its
 * owner can open. Where that socket lives, and refusing a place someone else
 * could have prepared, is what this module decides.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clearStaleSocket, daemonSocketPath, prepareSocketDirectory } from './daemon-socket.js'

let scratch: string
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'wb-socket-'))
})
afterEach(() => rmSync(scratch, { recursive: true, force: true }))

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
