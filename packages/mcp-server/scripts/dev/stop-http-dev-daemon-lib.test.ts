import { describe, expect, it } from 'vitest'
import { stopDevDaemon } from './stop-http-dev-daemon-lib.mjs'

const STARTED_AT = '2026-01-01T00:00:00.000Z'
const RECORDED_AT = Date.parse(STARTED_AT)

/**
 * Processes that die when signalled, after `dieAfterPolls` sleeps (never, when
 * null) — all but the `survivors`. Each started before the record was written
 * unless `startedAfter` names it. The daemon recorded its launch as `launch`
 * and its token as `token`, and its record is absent when `recorded` is false.
 */
function world({
  daemon = 100 as number | null,
  wrapper = null as number | null,
  dieAfterPolls = 0 as number | null,
  startedAfter = [] as number[],
  survivors = [] as number[],
  launch = undefined as 'built' | 'source' | undefined,
  recorded = true,
  token = undefined as string | undefined,
} = {}) {
  const alive = new Set<number>([daemon, wrapper].filter((pid): pid is number => pid !== null))
  const signalled: Array<[number, string]> = []
  let polls = 0
  let signalledAt: number | null = null
  return {
    signalled,
    input: {
      dataDir: '/data',
      readRecord: () =>
        daemon === null || !recorded
          ? null
          : { pid: daemon, socketPath: '/gone.sock', startedAt: STARTED_AT, launch, token },
      answers: async () => false,
      request: async (): Promise<{ status: number; text: string }> => {
        throw new Error('ENOENT')
      },
      startMs: (pid: number) =>
        startedAfter.includes(pid) ? RECORDED_AT + 60_000 : RECORDED_AT - 1,
      readWrapper: () => (wrapper === null ? null : { pid: wrapper, writtenAtMs: RECORDED_AT }),
      isAlive: (pid: number) => {
        if (
          signalledAt !== null &&
          dieAfterPolls !== null &&
          polls - signalledAt >= dieAfterPolls
        ) {
          for (const dead of [...alive]) if (!survivors.includes(dead)) alive.delete(dead)
        }
        return alive.has(pid)
      },
      kill: (pid: number, signal: string) => {
        signalled.push([pid, signal])
        signalledAt = polls
      },
      sleep: async () => {
        polls += 1
      },
      timeoutMs: 1_000,
      pollMs: 100,
    },
  }
}

describe('stopDevDaemon', () => {
  it('says there is nothing to stop when no daemon record names a live process', async () => {
    expect(await stopDevDaemon(world({ daemon: null }).input)).toEqual({ kind: 'none' })
    const w = world()
    expect(await stopDevDaemon({ ...w.input, isAlive: () => false })).toEqual({ kind: 'none' })
    expect(w.signalled).toEqual([])
  })

  it('signals the wrapper, not just the daemon, so tsx watch cannot restart it', async () => {
    const w = world({ wrapper: 50, dieAfterPolls: 2 })
    expect(await stopDevDaemon(w.input)).toEqual({ kind: 'stopped', via: 'wrapper', pid: 50 })
    expect(w.signalled).toEqual([[50, 'SIGTERM']])
  })

  it('falls back to the daemon when the wrapper pid is absent or dead', async () => {
    const w = world({ wrapper: null })
    expect(await stopDevDaemon(w.input)).toEqual({ kind: 'stopped', via: 'daemon', pid: 100 })
    expect(w.signalled).toEqual([[100, 'SIGTERM']])

    const dead = world()
    const deadWrapper = { ...dead.input, readWrapper: () => ({ pid: 7, writtenAtMs: RECORDED_AT }) }
    expect((await stopDevDaemon(deadWrapper)).kind).toBe('stopped')
    expect(dead.signalled).toEqual([[100, 'SIGTERM']])
  })

  it('signals nothing when the recorded pid is alive but is not the daemon', async () => {
    const w = world({ wrapper: 50, startedAfter: [100], token: 'tok' })
    expect(await stopDevDaemon(w.input)).toEqual({
      kind: 'stale',
      pid: 100,
      reason: expect.stringContaining('started after'),
    })
    expect(w.signalled).toEqual([])
  })

  it('signals a pid whose start time reads late when its socket answers as it', async () => {
    const w = world({ wrapper: 50, startedAfter: [100], token: 'tok' })
    const input = {
      ...w.input,
      answers: async () => true,
      request: async () => ({
        status: 200,
        contentType: 'application/json',
        text: JSON.stringify({ ok: true, pid: 100 }),
      }),
    }
    expect((await stopDevDaemon(input)).kind).toBe('stopped')
    expect(w.signalled).toEqual([[50, 'SIGTERM']])
  })

  it('signals the daemon, not a wrapper pid some later process has taken', async () => {
    const w = world({ wrapper: 50, startedAfter: [50] })
    expect(await stopDevDaemon(w.input)).toEqual({ kind: 'stopped', via: 'daemon', pid: 100 })
    expect(w.signalled).toEqual([[100, 'SIGTERM']])
  })

  it('stops a daemon too busy to answer its ping', async () => {
    const w = world()
    expect(await stopDevDaemon({ ...w.input, answers: async () => false })).toEqual({
      kind: 'stopped',
      via: 'daemon',
      pid: 100,
    })
  })

  it('reports a process that outlives the timeout rather than claiming it stopped', async () => {
    const w = world({ dieAfterPolls: null })
    expect(await stopDevDaemon(w.input)).toEqual({ kind: 'timeout', pid: 100, signalled: 100 })
  })

  // No wrapper launches a build, so a wrapper older than a BUILT daemon's record
  // is some other start's, and signalling it would leave the daemon running.
  it('signals a BUILT daemon itself, not an older live wrapper', async () => {
    const w = world({ wrapper: 50, launch: 'built' })
    expect(await stopDevDaemon(w.input)).toEqual({ kind: 'stopped', via: 'daemon', pid: 100 })
    expect(w.signalled).toEqual([[100, 'SIGTERM']])
  })

  it('names the pid still running on a timeout, not the one it signalled', async () => {
    const w = world({ wrapper: 50, survivors: [100] })
    expect(await stopDevDaemon(w.input)).toEqual({ kind: 'timeout', pid: 100, signalled: 50 })
    expect(w.signalled).toEqual([[50, 'SIGTERM']])
  })

  // A daemon that crashed under `tsx watch` removes its record while its
  // wrapper waits for the next edit — the state a start beside it refuses,
  // naming this stop as the way out.
  it('stops a live wrapper whose daemon is down', async () => {
    const w = world({ wrapper: 50, recorded: false })
    expect(await stopDevDaemon(w.input)).toEqual({ kind: 'stopped', via: 'wrapper', pid: 50 })
    expect(w.signalled).toEqual([[50, 'SIGTERM']])

    const crashed = world({ wrapper: 50, survivors: [50], dieAfterPolls: null })
    const deadDaemon = { ...crashed.input, isAlive: (pid: number) => pid === 50 }
    expect(await stopDevDaemon(deadDaemon)).toEqual({ kind: 'timeout', pid: 50, signalled: 50 })
    expect(crashed.signalled).toEqual([[50, 'SIGTERM']])
  })

  it('signals no wrapper pid some later process has taken when no daemon is up', async () => {
    const w = world({ wrapper: 50, recorded: false, startedAfter: [50] })
    expect(await stopDevDaemon(w.input)).toEqual({ kind: 'none' })
    expect(w.signalled).toEqual([])
  })

  // A forward step of the wall clock moves /proc/stat's btime but not a
  // process's start ticks, so every live process reads as having started
  // later than it did: the daemon after its own record. Its socket, asked
  // under the record's token, is what tells it from a process that took the pid.
  describe('after a forward clock step', () => {
    // Past the start-time slack for the wrapper too, not only the daemon.
    const STEP_MS = 8_000
    const stepped = (pid: number) =>
      (pid === 100 ? RECORDED_AT - 500 : RECORDED_AT - 2_000) + STEP_MS
    // Answers its status only to a request carrying the record's token, as the
    // daemon does; anything else gets the 401 a token-less ask gets.
    const servingAs =
      (pid: number) =>
      async (
        _record: { socketPath: string },
        req: { path: string; headers?: Record<string, string> },
      ) =>
        req.path === '/api/runtime/status' && req.headers?.authorization === 'Bearer tok'
          ? {
              status: 200,
              contentType: 'application/json',
              text: JSON.stringify({ ok: true, pid }),
            }
          : { status: 401, contentType: 'application/json', text: '{}' }

    it('stops a daemon whose socket names the recorded pid', async () => {
      const w = world({ wrapper: 50, dieAfterPolls: 1, token: 'tok' })
      const input = {
        ...w.input,
        startMs: stepped,
        answers: async () => true,
        request: servingAs(100),
      }
      expect(await stopDevDaemon(input)).toEqual({ kind: 'stopped', via: 'wrapper', pid: 50 })
      expect(w.signalled).toEqual([[50, 'SIGTERM']])

      const bare = world({ dieAfterPolls: 1, token: 'tok' })
      const alone = {
        ...bare.input,
        startMs: stepped,
        answers: async () => true,
        request: servingAs(100),
      }
      expect(await stopDevDaemon(alone)).toEqual({ kind: 'stopped', via: 'daemon', pid: 100 })
      expect(bare.signalled).toEqual([[100, 'SIGTERM']])
    })

    it('refuses, signalling nothing, when the socket answers as another pid', async () => {
      const w = world({ wrapper: 50, token: 'tok' })
      const input = {
        ...w.input,
        startMs: stepped,
        answers: async () => true,
        request: servingAs(4242),
      }
      expect(await stopDevDaemon(input)).toEqual({
        kind: 'unsignallable',
        pid: 100,
        reason: expect.stringContaining('/gone.sock'),
      })
      expect(w.signalled).toEqual([])
    })
  })
})
