import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer as createSocketServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import { socketTrust as daemonSocketTrust } from '../../src/daemon/daemon-socket.js'
import {
  requestDaemon,
  STATUS_PATH,
  socketTrust,
  UNTRUSTED_SOCKET,
} from './dev-daemon-socket-lib.mjs'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// The daemon refuses to send its token to a socket another user could have
// made; the dev scripts send theirs by the same rule, held here over the
// arrangements a real directory can be in.
describe("the socket ownership check against the daemon's own", () => {
  const ANOTHER_UID = (process.getuid?.() ?? 0) + 1

  async function arrangement(kind: string): Promise<string> {
    const root = mkdtempSync(join(tmpdir(), 'wb-sock-trust-'))
    dirs.push(root)
    const dir = join(root, 's')
    mkdirSync(dir, { mode: 0o700 })
    const path = join(dir, 'd.sock')
    if (kind === 'no-directory') return join(root, 'gone', 'd.sock')
    if (kind === 'absent') return path
    if (kind === 'file') {
      writeFileSync(path, '')
      return path
    }
    if (kind === 'symlink') {
      symlinkSync(join(root, 'elsewhere.sock'), path)
      return path
    }
    const server = createSocketServer()
    await new Promise<void>((resolve) => server.listen(path, () => resolve()))
    onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())))
    if (kind === 'open-directory') chmodSync(dir, 0o755)
    return path
  }

  it.each([
    ['absent', undefined, 'trusted'],
    ['absent', ANOTHER_UID, 'refused'],
    ['no-directory', undefined, 'absent'],
    ['file', undefined, 'trusted'],
    ['symlink', undefined, 'refused'],
    ['own-socket', undefined, 'trusted'],
    ['open-directory', undefined, 'refused'],
    ['own-socket', ANOTHER_UID, 'refused'],
  ])('agrees on a %s path checked for uid %s', async (kind, uid, expected) => {
    const path = await arrangement(kind)
    const seams = uid === undefined ? {} : { uid }
    const trust = daemonSocketTrust(path, seams)
    expect(trust.kind).toBe(expected)
    expect(socketTrust(path, seams)).toEqual(trust)
  })

  // Where the platform has no uids, ownership cannot be compared and only the
  // directory's mode is held to; neither side may read a missing uid as a
  // foreign one.
  it.each([
    ['own-socket', 'trusted'],
    ['open-directory', 'refused'],
  ])('agrees on a %s path where the platform has no uids', async (kind, expected) => {
    const path = await arrangement(kind)
    const getuid = process.getuid
    process.getuid = undefined
    try {
      expect(daemonSocketTrust(path).kind).toBe(expected)
      expect(socketTrust(path)).toEqual(daemonSocketTrust(path))
    } finally {
      process.getuid = getuid
    }
  })

  it('sends no token, and answers as a missing socket, where the socket directory does not exist', async () => {
    const path = await arrangement('no-directory')
    await expect(
      requestDaemon(
        { socketPath: path },
        { path: STATUS_PATH, headers: { authorization: 'Bearer t' } },
      ),
    ).rejects.toMatchObject({
      code: 'ENOENT',
      // Answered before any connect, which would say `connect ENOENT`.
      message: expect.stringMatching(/^no socket directory for /),
    })
  })

  it('refuses, before connecting, to send a token to a socket in an open directory', async () => {
    const path = await arrangement('open-directory')
    await expect(
      requestDaemon(
        { socketPath: path },
        { path: STATUS_PATH, headers: { authorization: 'Bearer t' } },
      ),
    ).rejects.toMatchObject({ code: UNTRUSTED_SOCKET })
  })
})
