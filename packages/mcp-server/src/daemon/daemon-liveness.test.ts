import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { endpointProof } from '../shared/endpoint-proof.js'
import { testSocketPath } from '../shared/test-utils/socket-fetch.js'
import { answeringDaemonSocket, collectingDaemonSocket } from './_test-daemon-socket.js'
import { daemonLiveness, servingPidOf } from './daemon-liveness.js'
import { DaemonNoAnswerError, type DaemonRequest, requestDaemon } from './daemon-request.js'
import { socketTrust } from './daemon-socket.js'

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
const noStartTime = { ...alive, startMs: () => null }

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

/** A listener collecting Authorization headers, answering as the recorded daemon would. */
const collectingSocket = (dirMode: number) => collectingDaemonSocket(dirMode, { pid: PID })

describe('daemonLiveness against a socket this user does not hold alone', () => {
  const ANOTHER_UID = (process.getuid?.() ?? 0) + 1

  it.each([
    ['started after its record', startedAfter],
    ['whose start time cannot be read', noStartTime],
    ['started before its record', startedBefore],
  ])('refuses, sending no token, a socket in a directory others can enter, for a pid %s', async (_, identity) => {
    const socket = await collectingSocket(0o755)
    const record = { pid: PID, startedAt, socketPath: socket.socketPath, token: TOKEN }
    const liveness = await daemonLiveness(record, identity)
    expect(liveness.state).toBe('unconfirmed')
    expect(liveness).toMatchObject({ untrustedSocket: expect.stringContaining('owner-only') })
    expect(socket.authorizations).toEqual([])
  })

  it('refuses, sending no token, a socket and directory another uid owns', async () => {
    const socket = await collectingSocket(0o700)
    const record = { pid: PID, startedAt, socketPath: socket.socketPath, token: TOKEN }
    const liveness = await daemonLiveness(record, {
      ...startedAfter,
      socketTrust: (path) => socketTrust(path, { uid: ANOTHER_UID }),
    })
    expect(liveness).toMatchObject({ state: 'unconfirmed', untrustedSocket: expect.any(String) })
    expect(socket.authorizations).toEqual([])
  })

  it('sends nothing to a missing socket in a directory another uid owns', async () => {
    const asked: DaemonRequest[] = []
    const record = { pid: PID, startedAt, socketPath: silentSocketPath(), token: TOKEN }
    await daemonLiveness(record, {
      ...startedAfter,
      request: async (req) => {
        asked.push(req)
        return { status: 200, body: { pid: PID } }
      },
      socketTrust: (path) => socketTrust(path, { uid: ANOTHER_UID }),
    })
    expect(asked).toEqual([])
  })

  it('sends nothing, and holds nothing, where the socket directory does not exist, for a pid started after its record', async () => {
    const asked: DaemonRequest[] = []
    const socketPath = join(silentSocketPath(), 'gone', 'd.sock')
    const record = { pid: PID, startedAt, socketPath, token: TOKEN }
    const liveness = await daemonLiveness(record, {
      ...startedAfter,
      request: async (req) => {
        asked.push(req)
        return { status: 200, body: { pid: PID } }
      },
    })
    expect(asked).toEqual([])
    expect(liveness.state).toBe('pid-reused')
  })

  // `running` is what hands a reader the record's socket and token: with no
  // directory there, whoever creates it first decides who receives them.
  it.each([
    ['whose start time cannot be read', noStartTime],
    ['started before its record', startedBefore],
  ])('does not call running, and asks nothing, a socket with no directory, for a pid %s', async (_, identity) => {
    const asked: DaemonRequest[] = []
    const socketPath = join(silentSocketPath(), 'gone', 'd.sock')
    const record = { pid: PID, startedAt, socketPath, token: TOKEN }
    const liveness = await daemonLiveness(record, {
      ...identity,
      request: async (req) => {
        asked.push(req)
        return { status: 200, body: { pid: PID } }
      },
    })
    expect(asked).toEqual([])
    expect(liveness).toEqual({
      state: 'unconfirmed',
      untrustedSocket: expect.stringContaining('does not exist'),
    })
  })

  it.each([
    ['whose start time cannot be read', noStartTime],
    ['started before its record', startedBefore],
  ])('holds the record of a socket the trust seam finds absent, for a pid %s', async (_, identity) => {
    const record = { pid: PID, startedAt, socketPath: '/run/whiteboard/d.sock', token: TOKEN }
    const liveness = await daemonLiveness(record, {
      ...identity,
      socketTrust: () => ({ kind: 'absent' }),
    })
    expect(liveness.state).toBe('unconfirmed')
  })

  it('asks, under the token, a socket in an owner-only directory of its own', async () => {
    const socket = await collectingSocket(0o700)
    const record = { pid: PID, startedAt, socketPath: socket.socketPath, token: TOKEN }
    expect(await daemonLiveness(record, startedAfter)).toEqual({ state: 'running' })
    expect(socket.authorizations).toEqual([`Bearer ${TOKEN}`])
  })
})

type ProofReply = (res: ServerResponse, body: string) => void

/**
 * A listener answering the endpoint proof for TOKEN, `reply` deciding how the
 * answer is sent. Returned as the `request` seam that reaches it under a
 * named-pipe record, since a pipe cannot be listened on here.
 */
async function provingSocket(reply: ProofReply) {
  const socketPath = testSocketPath()
  const server = createServer((req, res) => {
    const nonce = new URL(req.url ?? '/', 'http://daemon').searchParams.get('nonce') ?? ''
    void endpointProof(TOKEN, nonce).then((proof) => reply(res, JSON.stringify({ proof })))
  })
  await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()))
  onTestFinished(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  )
  return (req: DaemonRequest) => requestDaemon({ ...req, record: { ...req.record, socketPath } })
}

const PIPE = String.raw`\\.\pipe\wb-liveness-test`

describe('daemonLiveness over a named pipe', () => {
  const record = { pid: PID, startedAt, socketPath: PIPE, token: TOKEN }

  it('answers running when the pipe proves it holds the token', async () => {
    const request = await provingSocket((res, body) =>
      res.writeHead(200, { 'content-type': 'application/json' }).end(body),
    )
    expect(await daemonLiveness(record, { ...noStartTime, request })).toEqual({
      state: 'running',
    })
  })

  // An inactivity timeout restarts on every byte, so a server trickling one
  // keeps the ask open for as long as it likes.
  it('answers unconfirmed within a deadline when the pipe trickles its answer', async () => {
    const request = await provingSocket((res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.write('{"proof":')
      const drip = setInterval(() => res.write(' '), 100)
      res.on('close', () => clearInterval(drip))
    })
    const asked = daemonLiveness(record, { ...noStartTime, request })
    expect(await settlesWithin(asked, 4_000)).toEqual({ state: 'unconfirmed' })
  }, 10_000)

  it('answers unconfirmed when the proof arrives inside an oversized body', async () => {
    const request = await provingSocket((res, body) =>
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(`${body}${' '.repeat(256 * 1024)}`),
    )
    expect(await daemonLiveness(record, { ...noStartTime, request })).toEqual({
      state: 'unconfirmed',
    })
  })
})

describe('servingPidOf', () => {
  it.each([
    [{ state: 'running' } as const, {}],
    [{ state: 'unconfirmed' } as const, {}],
    [{ state: 'unconfirmed', servingPid: 7 } as const, { servingPid: 7 }],
    [{ state: 'pid-reused' } as const, {}],
    [{ state: 'dead' } as const, {}],
  ])('projects %o to %o', (liveness, expected) => {
    expect(servingPidOf(liveness)).toEqual(expected)
  })
})
