import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runtimeStatusResponseSchema } from '@kamiazya/whiteboard-daemon-client/api-contracts/runtime'
import { arbitraryForSchema } from '@kamiazya/whiteboard-model/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { daemonLiveness } from '../../src/daemon/daemon-liveness.js'
import { daemonRecordSchema } from '../../src/daemon/daemon-record-schema.js'
import { isPidAlive as daemonIsPidAlive } from '../../src/shared/process-alive.js'
import {
  readProcessStartMs as daemonReadProcessStartMs,
  recordedProcess as daemonRecordedProcess,
} from '../../src/shared/process-identity.js'
import { fc, fcTest, withDefaults } from '../../src/shared/test-utils/fast-check.js'
import {
  assessRecordedDaemon,
  BUILT_LAUNCH,
  isPidAlive,
  isRecordWriter,
  NO_ANSWER,
  readDaemonRecord,
  readProcessStartMs,
  recordedDaemonLiveness,
  requestDaemon,
} from './dev-daemon-socket-lib.mjs'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function dataDirWith(contents: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-socket-lib-'))
  dirs.push(dir)
  if (contents !== null) writeFileSync(join(dir, 'daemon.json'), contents)
  return dir
}

// The dev scripts cannot import `daemonRecordSchema` (they run under bare node
// before any build), so the reader restates the two fields they act on. This
// holds the restatement to the schema: whatever the daemon can write, the
// reader accepts.
describe('readDaemonRecord against the daemon record schema', () => {
  fcTest.prop([arbitraryForSchema(daemonRecordSchema)], withDefaults({ numRuns: 50 }))(
    'accepts every record the daemon can write, unchanged',
    (record) => {
      expect(readDaemonRecord(dataDirWith(JSON.stringify(record)))).toEqual(record)
    },
  )

  fcTest.prop(
    [arbitraryForSchema(daemonRecordSchema), fc.constantFrom('pid', 'socketPath')],
    withDefaults({ numRuns: 30 }),
  )('refuses a record missing a field the scripts act on', (record, field) => {
    const { [field as 'pid' | 'socketPath']: _dropped, ...rest } = record
    expect(readDaemonRecord(dataDirWith(JSON.stringify(rest)))).toBeNull()
  })

  // The wrapper names a built daemon by this value; a schema that renamed the
  // member would have every built daemon announced as the dev daemon.
  it('spells a built launch as the schema does', () => {
    expect(daemonRecordSchema.shape.launch.unwrap().options).toContain(BUILT_LAUNCH)
  })

  it('refuses the shape of the old port-based record, and what is not a record', () => {
    expect(
      readDaemonRecord(dataDirWith(JSON.stringify({ port: 4000, token: 't', pid: 1 }))),
    ).toBeNull()
    expect(readDaemonRecord(dataDirWith(JSON.stringify({ pid: 1, socketPath: '' })))).toBeNull()
    expect(readDaemonRecord(dataDirWith(JSON.stringify({ pid: 0, socketPath: '/s' })))).toBeNull()
    expect(readDaemonRecord(dataDirWith('[]'))).toBeNull()
    expect(readDaemonRecord(dataDirWith('{not json'))).toBeNull()
    expect(readDaemonRecord(dataDirWith(null))).toBeNull()
  })
})

// The dev wrapper refuses to start beside a live record by the same rule
// `whiteboard daemon run` does, so the two liveness checks must agree — on a
// running pid, a reaped one, and the pids that address a process GROUP.
describe("isPidAlive against the daemon's own", () => {
  it('gives the same answer for every kind of pid', () => {
    const reaped = spawnSync(process.execPath, ['-e', '']).pid
    // pid 1 exists everywhere and, for any user but root, answers EPERM.
    const pids = [process.pid, process.ppid, 1, reaped, 0, -1, -process.pid, Number.NaN, Infinity]
    expect(pids.map(isPidAlive)).toEqual(pids.map(daemonIsPidAlive))
    expect(isPidAlive(process.pid)).toBe(true)
    expect(isPidAlive(0)).toBe(false)
  })

  // The answer the comparison above reaches only when not run as root, held
  // here for every user: a pid that exists but is not ours to signal is a
  // daemon that may be running, and calling it dead starts a second one.
  it.each([
    ['EPERM', true],
    ['ESRCH', false],
    ['EINVAL', false],
  ] as const)('reads a probe failing with %s as the daemon does', (code, alive) => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error(code), { code })
    })
    try {
      expect([isPidAlive(4242), daemonIsPidAlive(4242)]).toEqual([alive, alive])
    } finally {
      kill.mockRestore()
    }
  })
})

describe('readProcessStartMs', () => {
  /** A /proc whose stat line for pid 42 has a command name built to trip a naive split. */
  function fakeProc(startTicks: number, btimeSeconds: number) {
    const files: Record<string, string> = {
      '/proc/42/stat': `42 (a) b c) S 1 42 42 0 -1 4194560 1 0 0 0 0 0 0 0 20 0 1 0 ${startTicks} 1000 10 18446744073709551615`,
      '/proc/stat': `cpu  1 2 3\nbtime ${btimeSeconds}\nprocesses 9\n`,
    }
    return (path: string) => {
      const text = files[path]
      if (text === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return text
    }
  }

  it('reads field 22 after the command name, in clock ticks past the boot time', () => {
    expect(readProcessStartMs(42, { readFile: fakeProc(12_345, 1_700_000_000) })).toBe(
      1_700_000_000_000 + 123_450,
    )
  })

  it('answers null where there is no /proc entry to read', () => {
    expect(readProcessStartMs(43, { readFile: fakeProc(1, 1) })).toBeNull()
  })

  it.skipIf(!existsSync('/proc/self/stat'))('places a real process between boot and now', () => {
    const start = readProcessStartMs(process.pid)
    expect(start).not.toBeNull()
    expect(start).toBeLessThanOrEqual(Date.now())
    expect(start).toBeGreaterThan(Date.now() - process.uptime() * 1000 - 2_000)
  })
})

// "This checkout's daemon is running" is decided here, once, for the wrapper's
// refusal, `pnpm mcp:http:stop` and the SessionStart hook. A record outlives
// its daemon, and its pid can come back as somebody else's process: that must
// read as no daemon, while a daemon too busy to answer a ping still must not.
describe('assessRecordedDaemon', () => {
  const startedAt = '2026-01-01T00:00:00.000Z'
  const recordedAt = Date.parse(startedAt)
  const record = { pid: 42, socketPath: '/s', startedAt }
  const seams = (over: Partial<Parameters<typeof assessRecordedDaemon>[1]> = {}) => ({
    answers: async () => false,
    isAlive: () => true,
    startMs: () => recordedAt - 5_000,
    ...over,
  })

  it('is running when the socket answers', async () => {
    expect(await assessRecordedDaemon(record, seams({ answers: async () => true }))).toEqual({
      running: true,
      answering: true,
      process: 'daemon',
    })
  })

  it('is running, not answering, when the recorded pid is the daemon but the ping times out', async () => {
    expect(await assessRecordedDaemon(record, seams())).toEqual({
      running: true,
      answering: false,
      process: 'daemon',
    })
  })

  it('is not running when the recorded pid started after the record was written', async () => {
    expect(
      await assessRecordedDaemon(record, seams({ startMs: () => recordedAt + 60_000 })),
    ).toEqual({ running: false, answering: false, process: 'foreign' })
  })

  it('is not running when the recorded pid is gone', async () => {
    expect(await assessRecordedDaemon(record, seams({ isAlive: () => false }))).toEqual({
      running: false,
      answering: false,
      process: 'dead',
    })
  })

  it('takes a live pid as the daemon when the start time or the record cannot say otherwise', async () => {
    expect((await assessRecordedDaemon(record, seams({ startMs: () => null }))).running).toBe(true)
    const { startedAt: _absent, ...undated } = record
    const late = seams({ startMs: () => Date.now() })
    expect((await assessRecordedDaemon(undated, late)).running).toBe(true)
    expect((await assessRecordedDaemon({ ...record, startedAt: 'never' }, late)).running).toBe(true)
  })

  it.skipIf(!existsSync('/proc/self/stat'))(
    'reads a real process that took over a stale record’s pid as not the daemon',
    async () => {
      const standIn = spawn('sleep', ['30'], { stdio: 'ignore' })
      try {
        const stale = {
          pid: standIn.pid as number,
          socketPath: join(dataDirWith(null), 'gone.sock'),
          startedAt: new Date(Date.now() - 60_000).toISOString(),
        }
        expect(await assessRecordedDaemon(stale)).toEqual({
          running: false,
          answering: false,
          process: 'foreign',
        })
        const current = { ...stale, startedAt: new Date(Date.now() + 1_000).toISOString() }
        expect((await assessRecordedDaemon(current)).process).toBe('daemon')
      } finally {
        standIn.kill('SIGKILL')
      }
    },
  )
})

describe('requestDaemon', () => {
  async function answering(contentType: string, chunks: string[]) {
    const socketPath = join(dataDirWith(null), 'daemon.sock')
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': contentType })
      for (const chunk of chunks) res.write(chunk)
      res.end()
    })
    await new Promise<void>((listening) => server.listen(socketPath, () => listening()))
    return {
      socketPath,
      close: () => new Promise<void>((closed) => server.close(() => closed())),
    }
  }

  // A relayed stream may never end, so holding its body would grow for its life.
  it('keeps no body for a 2xx event stream it hands to onChunk', async () => {
    const chunks = ['data: {"a":1}\n\n', 'data: {"b":2}\n\n']
    const daemon = await answering('text/event-stream', chunks)
    try {
      const seen: string[] = []
      const answer = await requestDaemon(daemon, {
        path: '/mcp',
        onChunk: (chunk: string) => seen.push(chunk),
      })
      expect(seen.join('')).toBe(chunks.join(''))
      expect(answer).toEqual({ status: 200, contentType: 'text/event-stream', text: '' })
    } finally {
      await daemon.close()
    }
  })

  it('keeps the body of any other reply, relayed or not', async () => {
    const daemon = await answering('application/json', ['{"ok":', 'true}'])
    try {
      const relayed = await requestDaemon(daemon, { path: '/mcp', onChunk: () => {} })
      expect(relayed.text).toBe('{"ok":true}')
      const plain = await requestDaemon(daemon, { path: '/mcp' })
      expect(plain.text).toBe('{"ok":true}')
    } finally {
      await daemon.close()
    }
    const stream = await answering('text/event-stream', ['data: {}\n\n'])
    try {
      expect((await requestDaemon(stream, { path: '/mcp' })).text).toBe('data: {}\n\n')
    } finally {
      await stream.close()
    }
  })
})

// What a liveness check makes of a socket that says nothing depends on WHY it
// said nothing: a connection refused, or no socket at all, is no daemon, while
// one taken and then left unanswered is a daemon wedged on its loop.
describe('a socket that says nothing', () => {
  async function wedged() {
    const socketPath = join(dataDirWith(null), 'wedged.sock')
    const server = createServer(() => {})
    await new Promise<void>((listening) => server.listen(socketPath, () => listening()))
    return {
      socketPath,
      close: () =>
        new Promise<void>((closed) => {
          server.close(() => closed())
          server.closeAllConnections()
        }),
    }
  }

  it('rejects as unanswered once a connection it took stays silent', async () => {
    const daemon = await wedged()
    try {
      await expect(requestDaemon(daemon, { path: '/x', timeoutMs: 100 })).rejects.toMatchObject({
        code: NO_ANSWER,
      })
    } finally {
      await daemon.close()
    }
  })

  it('rejects as a refused connection when nothing listens', async () => {
    const socketPath = join(dataDirWith(null), 'nobody.sock')
    const refused = await requestDaemon({ socketPath }, { path: '/x', timeoutMs: 100 }).catch(
      (error: { code?: string }) => error,
    )
    expect(refused).toMatchObject({ code: expect.any(String) })
    expect((refused as { code: string }).code).not.toBe(NO_ANSWER)
  })

  it('reads a late-starting pid behind a wedged socket as unconfirmed, behind none as reused', async () => {
    const startedAt = '2026-01-01T00:00:00.000Z'
    const late = { isAlive: () => true, startMs: () => Date.parse(startedAt) + 60_000 }
    const daemon = await wedged()
    try {
      const record = { pid: 42, startedAt, socketPath: daemon.socketPath, token: 't' }
      expect(await recordedDaemonLiveness(record, late)).toBe('unconfirmed')
    } finally {
      await daemon.close()
    }
    const gone = { pid: 42, startedAt, socketPath: join(dataDirWith(null), 'gone.sock') }
    expect(await recordedDaemonLiveness(gone, late)).toBe('pid-reused')
  })
})

describe('isRecordWriter', () => {
  const writtenAt = '2026-01-01T00:00:10.000Z'
  const writtenAtMs = Date.parse(writtenAt)

  it('answers true for a live process that started before the record was written', () => {
    expect(
      isRecordWriter(7, writtenAt, { isAlive: () => true, startMs: () => writtenAtMs - 1_000 }),
    ).toBe(true)
  })

  it('answers false for a live process that took the pid after the record was written', () => {
    expect(
      isRecordWriter(7, writtenAt, { isAlive: () => true, startMs: () => writtenAtMs + 60_000 }),
    ).toBe(false)
  })

  it('answers false for a dead pid', () => {
    expect(isRecordWriter(7, writtenAt, { isAlive: () => false, startMs: () => 0 })).toBe(false)
  })
})

// The dev scripts run under bare node before any build, so they keep a copy
// of the daemon's "did this pid write this record" judgement. This holds the
// copy to the daemon's answers over the same /proc and the same clock.
describe("the pid-reuse judgement against the daemon's own", () => {
  function fakeProc(startTicks: number, btimeSeconds: number) {
    return (path: string) => {
      if (path === '/proc/stat') return `cpu  1 2 3\nbtime ${btimeSeconds}\n`
      if (path === '/proc/42/stat') {
        return `42 (we(i)rd) name) S 1 42 42 0 -1 4194560 1 0 0 0 0 0 0 0 20 0 1 0 ${startTicks} 1 1`
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    }
  }

  fcTest.prop(
    [fc.nat({ max: 2 ** 31 }), fc.integer({ min: 0, max: 2_000_000_000 })],
    withDefaults({ numRuns: 100 }),
  )('reads the same start time from the same /proc', (ticks, btime) => {
    const readFile = fakeProc(ticks, btime)
    expect(readProcessStartMs(42, { readFile })).toBe(daemonReadProcessStartMs(42, { readFile }))
    expect(readProcessStartMs(43, { readFile })).toBe(daemonReadProcessStartMs(43, { readFile }))
  })

  fcTest.prop(
    [
      fc.boolean(),
      fc.option(fc.integer({ min: 0, max: 20_000 }), { nil: null }),
      fc.integer({ min: 0, max: 20_000 }),
    ],
    withDefaults({ numRuns: 200 }),
  )('agrees on whether a pid still names its writer', (alive, startMs, writtenAtMs) => {
    const seams = { isAlive: () => alive, startMs: () => startMs }
    expect(isRecordWriter(7, new Date(writtenAtMs).toISOString(), seams)).toBe(
      daemonRecordedProcess(7, writtenAtMs, seams) === 'writer',
    )
  })
})

// `pnpm mcp:http:stop` decides whether to signal a pid by this verdict, so it
// must be the daemon's own: a stop that calls a daemon stale which the daemon
// calls running leaves it serving, unstoppable, with its worktree deleted
// around it. Held over the same /proc answers, clock and socket replies — a
// stepped clock included, which is where the socket is asked at all.
describe("the liveness verdict against the daemon's own", () => {
  const RECORDED_PID = 7
  // What the socket says, as the daemon's request helper hands it over (a
  // parsed body) — the dev helper gets the same reply as its raw text. A
  // status names the recorded pid or another; the other bodies name none.
  // Weighted so the arrangement that matters — a late start time, a socket,
  // and a status confirming the pid — is common rather than a rare corner.
  const replyArbitrary = fc.oneof(
    // Nothing listening: the connection is refused.
    { arbitrary: fc.constant({ kind: 'refused' as const }), weight: 1 },
    // Listening, taking the connection, never answering: a wedged daemon.
    { arbitrary: fc.constant({ kind: 'wedged' as const }), weight: 1 },
    {
      arbitrary: fc.record({
        kind: fc.constant('reply' as const),
        status: fc.constantFrom(200, 200, 200, 401, 500),
        body: fc.oneof(
          {
            arbitrary: fc
              .tuple(
                arbitraryForSchema(runtimeStatusResponseSchema),
                fc.constantFrom(RECORDED_PID, 8),
              )
              .map(([status, pid]) => ({ ...status, pid }) as unknown),
            weight: 4,
          },
          { arbitrary: fc.record({ ok: fc.boolean() }) as fc.Arbitrary<unknown>, weight: 1 },
          { arbitrary: fc.string().map((text) => `not json ${text}` as unknown), weight: 1 },
          { arbitrary: fc.constant(undefined as unknown), weight: 1 },
        ),
      }),
      weight: 3,
    },
  )

  it('agrees on running, unconfirmed, pid-reused and dead', async () => {
    const seen = new Set<string>()
    let confirmedBySocket = 0
    let wedgedUnconfirmed = 0
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(true, true, true, false),
        // The start time relative to the record: before it, inside the slack,
        // or past it as a stepped clock or a reused pid makes it.
        fc.option(fc.integer({ min: -10_000, max: 20_000 }), { nil: null, freq: 8 }),
        fc.integer({ min: 0, max: 20_000 }),
        fc.option(fc.constant('/daemon.sock'), { nil: undefined, freq: 8 }),
        fc.option(fc.string({ minLength: 1, maxLength: 8 }), { nil: undefined }),
        replyArbitrary,
        async (alive, offset, writtenAtMs, socketPath, token, reply) => {
          const started = offset === null ? null : writtenAtMs + offset
          const record = {
            pid: RECORDED_PID,
            startedAt: new Date(writtenAtMs).toISOString(),
            ...(socketPath === undefined ? {} : { socketPath }),
            ...(token === undefined ? {} : { token }),
          }
          const identity = { isAlive: () => alive, startMs: () => started }
          // The socket answers only an ask carrying the record's token, as the
          // daemon does, so a side that dropped the token reads a 401.
          const answer = (presented: string | undefined) => {
            if (reply.kind === 'refused') {
              throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
            }
            if (reply.kind === 'wedged') throw new Error('no answer within 1500ms')
            return presented === token ? reply : { status: 401, body: {} }
          }
          const daemonSide = await daemonLiveness(record, {
            ...identity,
            request: async (req) => answer(req.record.token),
          })
          const devSide = await recordedDaemonLiveness(record, {
            ...identity,
            request: async (_record, req) => {
              if (reply.kind === 'wedged') {
                throw Object.assign(new Error('no answer within 1500ms'), { code: NO_ANSWER })
              }
              const presented = req.headers?.authorization?.replace(/^Bearer /, '')
              const { status, body } = answer(presented)
              const text =
                body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)
              return { status, contentType: 'application/json', text }
            },
          })
          if (reply.kind === 'wedged') {
            // The daemon's request helper does not yet tell a wedged socket
            // from a refused one, so its verdict there reads 'pid-reused'
            // where the agreed answer is 'unconfirmed'. Once it does, this
            // branch becomes the plain comparison below, with the daemon
            // side's fake rejecting the way that helper does on a timeout.
            const asked = daemonSide === 'pid-reused' && socketPath !== undefined
            expect(devSide).toBe(asked ? 'unconfirmed' : daemonSide)
            if (devSide === 'unconfirmed') wedgedUnconfirmed += 1
          } else {
            expect(devSide).toBe(daemonSide)
          }
          seen.add(devSide)
          if (daemonSide === 'running' && offset !== null && offset > 5_000) {
            confirmedBySocket += 1
          }
        },
      ),
      withDefaults({ numRuns: 400 }),
    )
    // A generator that never reached the socket would agree vacuously.
    expect([...seen].sort()).toEqual(['dead', 'pid-reused', 'running', 'unconfirmed'])
    expect(confirmedBySocket).toBeGreaterThan(0)
    expect(wedgedUnconfirmed).toBeGreaterThan(0)
  })
})
