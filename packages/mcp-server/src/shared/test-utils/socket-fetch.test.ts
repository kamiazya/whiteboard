import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SOCKET_PATH_MAX_BYTES } from '../../daemon/daemon-socket.js'
import { testSocketPath } from './socket-fetch.js'

const dirs: string[] = []

afterEach(() => {
  vi.unstubAllEnvs()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('testSocketPath', () => {
  it('refuses a TMPDIR long enough that the kernel would truncate the socket path', () => {
    const base = mkdtempSync(join(tmpdir(), 'wb-long-tmp-'))
    dirs.push(base)
    const longTmp = join(base, 'a'.repeat(100))
    mkdirSync(longTmp)
    vi.stubEnv('TMPDIR', longTmp)
    expect(() => testSocketPath()).toThrow(
      new RegExp(`${SOCKET_PATH_MAX_BYTES}-byte limit.*shorter TMPDIR`),
    )
  })

  it('answers a path under the limit for the default TMPDIR', () => {
    expect(Buffer.byteLength(testSocketPath())).toBeLessThanOrEqual(SOCKET_PATH_MAX_BYTES)
  })
})
