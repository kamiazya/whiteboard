import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { requestDaemon } from '../dev-daemon-socket-lib.mjs'
import { startFakeMcpResponder } from './fake-mcp-daemon.mjs'

const dirs: string[] = []
const closers: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const close of closers.splice(0)) await close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('startFakeMcpResponder', () => {
  it('answers the ping and an authenticated POST /mcp on its socket, and refuses anything else', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fake-mcp-daemon-'))
    dirs.push(dir)
    const socketPath = join(dir, 'daemon.sock')
    closers.push((await startFakeMcpResponder({ socketPath, token: 'tok' })).close)
    const record = { socketPath }

    expect((await requestDaemon(record, { path: '/api/runtime/ping' })).status).toBe(200)
    const post = (authorization: string, path = '/mcp') =>
      requestDaemon(record, { method: 'POST', path, headers: { authorization } })
    expect((await post('Bearer tok')).status).toBe(200)
    expect((await post('Bearer x')).status).toBe(401)
    expect((await post('Bearer tok', '/nope')).status).toBe(404)
  })
})
