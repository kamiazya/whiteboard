import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { testSocketPath } from '../shared/test-utils/socket-fetch.js'
import { answeringDaemonSocket } from './_test-daemon-socket.js'
import { daemonLiveness } from './daemon-liveness.js'
import { DaemonNoAnswerError, requestDaemon } from './daemon-request.js'

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

/** A listener that accepts the connection and never answers: a daemon busy on its loop. */
async function wedgedSocket(): Promise<string> {
  const socketPath = testSocketPath()
  const server = createServer(() => {})
  await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()))
  onTestFinished(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  )
  return socketPath
}

/** A listener that sends the answer's headers and part of its body, then hangs up: a daemon dying mid-reply. */
async function hangsUpMidAnswerSocket(): Promise<string> {
  const socketPath = testSocketPath()
  const server = createNetServer((socket) => {
    socket.once('data', () => {
      socket.write(
        'HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 64\r\n\r\n{"pid":',
        () => socket.destroy(),
      )
    })
  })
  await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()))
  onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())))
  return socketPath
}

/** Fails, rather than waiting out the test's own timeout, when `pending` never settles. */
function settlesWithin<T>(pending: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`did not settle within ${ms}ms`)), ms)
  })
  return Promise.race([pending, late]).finally(() => clearTimeout(timer))
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

  it('answers pid-reused when the socket path is a file nothing listens through', async () => {
    const socketPath = silentSocketPath()
    writeFileSync(socketPath, '')
    const record = { pid: PID, startedAt, socketPath, token: TOKEN }
    expect(await daemonLiveness(record, startedAfter)).toEqual({ state: 'pid-reused' })
  })

  // Something accepted the connection, so something serves that socket: a
  // daemon too busy to answer in time is still there, and calling its pid
  // reused would let `daemon stop` delete the record of a daemon still serving.
  it('answers unconfirmed, within the ask timeout, when the socket accepts and never answers', async () => {
    const record = { pid: PID, startedAt, socketPath: await wedgedSocket(), token: TOKEN }
    const askedAt = Date.now()
    expect(await daemonLiveness(record, startedAfter)).toEqual({ state: 'unconfirmed' })
    expect(Date.now() - askedAt).toBeLessThan(5_000)
  }, 10_000)

  it('rejects with no answer, rather than waiting forever, when the socket hangs up mid-answer', async () => {
    const socketPath = await hangsUpMidAnswerSocket()
    const asked = requestDaemon({ record: { socketPath }, method: 'GET', path: '/' })
    await expect(settlesWithin(asked, 3_000)).rejects.toBeInstanceOf(DaemonNoAnswerError)
  }, 10_000)

  it('answers unconfirmed when the socket hangs up mid-answer', async () => {
    const record = { pid: PID, startedAt, socketPath: await hangsUpMidAnswerSocket(), token: TOKEN }
    expect(await settlesWithin(daemonLiveness(record, startedAfter), 3_000)).toEqual({
      state: 'unconfirmed',
    })
  }, 10_000)

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

  // Only the pid decides: a daemon of another version answers a status this
  // build's contract may refuse, and it is still the daemon if it names the pid.
  it('answers running when an answer outside the status contract names the recorded pid', async () => {
    const daemon = await answeringDaemonSocket(PID, TOKEN, {
      body: { ok: true, pid: PID, version: '0.0.1' },
    })
    const record = { pid: PID, startedAt, socketPath: daemon.socketPath, token: TOKEN }
    expect(await daemonLiveness(record, startedAfter)).toEqual({ state: 'running' })
  })

  it.each([
    0, -1, 1.5,
  ])('names no serving pid when a status otherwise in contract says pid %s', async (pid) => {
    const daemon = await answeringDaemonSocket(pid, TOKEN)
    const record = { pid: PID, startedAt, socketPath: daemon.socketPath, token: TOKEN }
    expect(await daemonLiveness(record, startedAfter)).toEqual({ state: 'unconfirmed' })
  })
})
