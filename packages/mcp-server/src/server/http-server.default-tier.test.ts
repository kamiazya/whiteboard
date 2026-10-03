import { mkdtemp, rm } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunningServer } from './http-server.js'

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
const { clearWorkspaceIdCacheForTests } = await import('./current-workspace.js')
const { closeDb } = await import('./store/db/index.js')

function getJson(socketPath: string, path: string, token: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = request(
      { socketPath, path, headers: { authorization: `Bearer ${token}` } },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          body += chunk
        })
        res.on('end', () => resolve(JSON.parse(body)))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

describe('startHttpServer without a replica-tier override', () => {
  let running: RunningServer | undefined
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-http-tier-'))
    clearWorkspaceIdCacheForTests()
  })
  afterEach(async () => {
    await running?.close()
    running = undefined
    await closeDb(tempDir)
    clearWorkspaceIdCacheForTests()
    await rm(tempDir, { recursive: true, force: true })
  })

  it('lists every workspace with the default replica tier, so the read plane has a tier to enforce', async () => {
    const socketPath = join(tempDir, 'run', 'daemon.sock')
    running = await startHttpServer({ token: 't', socketPath })
    const listed = (await getJson(socketPath, '/api/workspaces', 't')) as {
      workspaces: { tier?: string }[]
    }
    expect(listed.workspaces.length).toBeGreaterThan(0)
    for (const row of listed.workspaces) expect(typeof row.tier).toBe('string')
  })
})
