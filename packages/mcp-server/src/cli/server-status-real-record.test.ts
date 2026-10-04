import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runServerStatus } from './server-status.js'

// server-status.test.ts mocks the record reader and injects every seam, so the
// defaults — the data dir, the real record parse, the real liveness check —
// are only exercised here.

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wb-server-status-'))
  vi.stubEnv('WHITEBOARD_DATA_DIR', dir)
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(dir, { recursive: true, force: true })
})

const record = (pid: number, extra: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  pid,
  host: '127.0.0.1',
  port: 3099,
  publicBaseUrl: 'https://whiteboard.example.com',
  authStrategy: 'oauth-jwt',
  startedAt: '2026-05-19T00:00:00.000Z',
  ...extra,
})

const writeRecord = (body: unknown) =>
  writeFile(join(dir, 'server-mode.json'), JSON.stringify(body), { mode: 0o600 })

/** A pid that has exited: a child spawned and reaped synchronously. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', '0'])
  if (child.pid === undefined) throw new Error('child process reported no pid')
  return child.pid
}

describe('runServerStatus against a real record and the real defaults', () => {
  it('reads the record from the default data dir when none is passed', async () => {
    await writeRecord(record(process.pid, { instanceId: 'abc' }))
    const { result } = await runServerStatus({ verifyIdentity: async () => true })
    expect(result.state).toBe('running')
  })

  it('says missing when the default data dir holds no record', async () => {
    const { result, exitCode } = await runServerStatus({})
    expect(result.state).toBe('missing')
    expect(exitCode).toBe(1)
  })

  it('uses the real liveness check: a record naming a dead process is stale, never verified', async () => {
    await writeRecord(record(deadPid(), { instanceId: 'abc' }))
    const { result } = await runServerStatus({
      verifyIdentity: async () => {
        throw new Error('identity must not be asked of a dead process')
      },
    })
    expect(result.state).toBe('stale')
  })

  it('a dead process with a legacy record (no instanceId) is stale, not unverifiable', async () => {
    await writeRecord(record(deadPid()))
    const { result } = await runServerStatus({ verifyIdentity: async () => false })
    expect(result.state).toBe('stale')
  })
})
