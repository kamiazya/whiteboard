import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runtimeStatusResponseSchema } from '@kamiazya/whiteboard-daemon-client/api-contracts/runtime'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { testSocketPath } from '../shared/test-utils/socket-fetch.js'

let tmpRoot: string

vi.mock('./config.js', () => ({
  get DATA_DIR() {
    return tmpRoot
  },
  getDataDir: () => tmpRoot,
  get DIST_WEB_APP_DIR() {
    return join(tmpRoot, 'dist-web-app')
  },
  WHITEBOARD_ROOT: '/tmp/whiteboard',
}))

const { startHttpServer } = await import('./http-server.js')

// ADR-0050: the local daemon answers on its socket and nowhere else, and
// serves no UI — so its status names the socket and no port, host, base URL,
// MCP endpoint or app build, each of which would be a field describing
// something that does not exist.
describe('startHttpServer runtime status', () => {
  let running: Awaited<ReturnType<typeof startHttpServer>> | undefined

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'whiteboard-http-status-'))
  })

  afterEach(async () => {
    await running?.close()
    running = undefined
    await rm(tmpRoot, { recursive: true, force: true })
  })

  it('names the socket it answers on, and no listener it does not have', async () => {
    const socketPath = testSocketPath()
    running = await startHttpServer({ socketPath })

    const status = runtimeStatusResponseSchema.parse(running.getRuntimeStatus())
    expect(status.socketPath).toBe(socketPath)
    expect(status).not.toHaveProperty('port')
    expect(status).not.toHaveProperty('host')
    expect(status).not.toHaveProperty('baseUrl')
    expect(status).not.toHaveProperty('app')
    expect(status.mcp).toEqual({ httpEnabled: true })
  })
})
