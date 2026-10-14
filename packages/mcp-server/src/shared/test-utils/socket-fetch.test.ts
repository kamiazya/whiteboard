import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { listenOnSocket } from '../../daemon/daemon-socket.js'
import { TEST_SOCKET_PATH_MAX_BYTES, testSocketPath } from './socket-fetch.js'

const dirs: string[] = []

afterEach(() => {
  vi.unstubAllEnvs()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A socket path of exactly `bytes` bytes, in a fresh owner-only directory. */
function pathOfLength(bytes: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-limit-'))
  dirs.push(dir)
  const stem = join(dir, 's')
  const pad = bytes - Buffer.byteLength(stem) - '.sock'.length
  if (pad < 0) throw new Error(`tmpdir is too long to build a ${bytes}-byte path: ${dir}`)
  return `${stem}${'a'.repeat(pad)}.sock`
}

describe('testSocketPath', () => {
  it('refuses a TMPDIR long enough that the kernel would truncate the socket path', () => {
    const base = mkdtempSync(join(tmpdir(), 'wb-long-tmp-'))
    dirs.push(base)
    const longTmp = join(base, 'a'.repeat(100))
    mkdirSync(longTmp)
    vi.stubEnv('TMPDIR', longTmp)
    expect(() => testSocketPath()).toThrow(
      new RegExp(`${TEST_SOCKET_PATH_MAX_BYTES}-byte limit.*shorter TMPDIR`),
    )
  })

  it.skipIf(process.platform === 'win32')(
    'holds the limit the daemon itself binds at, and not one byte over it',
    async () => {
      const fits = await listenOnSocket(
        () => new Response('ok'),
        pathOfLength(TEST_SOCKET_PATH_MAX_BYTES),
      )
      await fits.close()
      await expect(
        listenOnSocket(() => new Response('ok'), pathOfLength(TEST_SOCKET_PATH_MAX_BYTES + 1)),
      ).rejects.toThrow(`${TEST_SOCKET_PATH_MAX_BYTES}-byte limit`)
    },
  )
})
