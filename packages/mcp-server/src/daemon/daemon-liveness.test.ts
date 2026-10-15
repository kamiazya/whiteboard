import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { answeringDaemonSocket } from './_test-daemon-socket.js'
import { daemonLiveness } from './daemon-liveness.js'

const startedAt = '2026-01-01T00:00:00.000Z'
const writtenAtMs = Date.parse(startedAt)
const PID = 4242
const TOKEN = 'tok'

/** A socket path nothing listens on, in a directory of the test's own. */
function silentSocketPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-live-'))
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  return join(dir, 'none.sock')
}

const alive = { isAlive: () => true }
const startedBefore = { ...alive, startMs: () => writtenAtMs - 1_000 }
// A forward wall-clock step of 6 s: the daemon reads as starting after its record.
const startedAfter = { ...alive, startMs: () => writtenAtMs + 6_000 }

describe('daemonLiveness', () => {
  it('answers dead for a pid no process has', async () => {
    const record = { pid: PID, startedAt, socketPath: silentSocketPath() }
    expect(await daemonLiveness(record, { isAlive: () => false })).toEqual({ state: 'dead' })
  })

  it('answers running, asking no socket, for a pid that started before its record', async () => {
    const daemon = await answeringDaemonSocket(PID, TOKEN)
    const record = { pid: PID, startedAt, socketPath: daemon.socketPath, token: TOKEN }
    expect(await daemonLiveness(record, startedBefore)).toEqual({ state: 'running' })
    expect(daemon.asked).toEqual([])
  })

  it('answers running where the platform cannot tell when a process started', async () => {
    const record = { pid: PID, startedAt, socketPath: silentSocketPath() }
    expect(await daemonLiveness(record, { ...alive, startMs: () => null })).toEqual({
      state: 'running',
    })
  })

  it('answers pid-reused for a later process when nothing answers on the socket', async () => {
    const record = { pid: PID, startedAt, socketPath: silentSocketPath(), token: TOKEN }
    expect(await daemonLiveness(record, startedAfter)).toEqual({ state: 'pid-reused' })
  })

  it('answers pid-reused for a later process when the record names no socket', async () => {
    expect(await daemonLiveness({ pid: PID, startedAt }, startedAfter)).toEqual({
      state: 'pid-reused',
    })
  })

  it('answers running when the socket, asked under the token, names the recorded pid', async () => {
    const daemon = await answeringDaemonSocket(PID, TOKEN)
    const record = { pid: PID, startedAt, socketPath: daemon.socketPath, token: TOKEN }
    expect(await daemonLiveness(record, startedAfter)).toEqual({ state: 'running' })
    expect(daemon.asked).toEqual(['/api/runtime/status'])
  })

  it('answers unconfirmed, naming the pid that answered, when the socket names another', async () => {
    const daemon = await answeringDaemonSocket(PID + 1, TOKEN)
    const record = { pid: PID, startedAt, socketPath: daemon.socketPath, token: TOKEN }
    expect(await daemonLiveness(record, startedAfter)).toEqual({
      state: 'unconfirmed',
      servingPid: PID + 1,
    })
  })

  it('answers unconfirmed when the socket refuses the recorded token', async () => {
    const daemon = await answeringDaemonSocket(PID, 'another-token')
    const record = { pid: PID, startedAt, socketPath: daemon.socketPath, token: TOKEN }
    expect(await daemonLiveness(record, startedAfter)).toEqual({ state: 'unconfirmed' })
  })
})
