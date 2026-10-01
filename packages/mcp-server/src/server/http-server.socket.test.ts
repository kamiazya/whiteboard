import { existsSync, statSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunningServer } from './http-server.js'

// Its own data dir: `config.js` is mocked onto it, so nothing here touches the real one.
let tempDir: string

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js')
  return {
    ...actual,
    get DATA_DIR() {
      return tempDir
    },
    getDataDir: () => tempDir,
  }
})

const { startHttpServer } = await import('./http-server.js')
const { clearWorkspaceIdCache } = await import('./current-workspace.js')
const { closeDb } = await import('./store/db/index.js')

function getOverSocket(
  socketPath: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, headers }, (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    req.on('error', reject)
    req.end()
  })
}

// ADR-0050 decision 2: the daemon answers its API on a socket only its owner
// can open, and nowhere else.
describe('startHttpServer on a local socket (ADR-0050)', () => {
  let running: RunningServer | undefined

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-http-socket-'))
    clearWorkspaceIdCache()
  })

  afterEach(async () => {
    await running?.close()
    running = undefined
    await closeDb(tempDir)
    clearWorkspaceIdCache()
    await rm(tempDir, { recursive: true, force: true })
  })

  it('serves the API on an owner-only socket and removes it on close', async () => {
    const socketPath = join(tempDir, 'run', 'daemon.sock')
    running = await startHttpServer({ socketPath })

    expect(await getOverSocket(socketPath, '/api/runtime/ping')).toBe(200)
    expect(statSync(socketPath).mode & 0o777).toBe(0o600)

    await running.close()
    running = undefined
    expect(existsSync(socketPath)).toBe(false)
  })
  // Reaching the socket is not itself a credential: the directory keeps other
  // users out, and the token still decides for everyone who gets that far.
  it('asks for the daemon token on the socket', async () => {
    const socketPath = join(tempDir, 'run', 'daemon.sock')
    running = await startHttpServer({ token: 'socket-token', socketPath })

    expect(await getOverSocket(socketPath, '/api/workspaces')).toBe(401)
    expect(
      await getOverSocket(socketPath, '/api/workspaces', {
        authorization: 'Bearer socket-token',
      }),
    ).toBe(200)
  })
})
