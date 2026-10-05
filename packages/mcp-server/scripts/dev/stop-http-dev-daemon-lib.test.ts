import { describe, expect, it } from 'vitest'
import { stopDevDaemon } from './stop-http-dev-daemon-lib.mjs'

const STARTED_AT = '2026-01-01T00:00:00.000Z'
const RECORDED_AT = Date.parse(STARTED_AT)

/**
 * Processes that die when signalled, after `dieAfterPolls` sleeps (never, when
 * null). Each started before the record was written unless `startedAfter`
 * names it.
 */
function world({
  daemon = 100 as number | null,
  wrapper = null as number | null,
  dieAfterPolls = 0 as number | null,
  startedAfter = [] as number[],
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
        daemon === null ? null : { pid: daemon, socketPath: '/gone.sock', startedAt: STARTED_AT },
      answers: async () => false,
      startMs: (pid: number) =>
        startedAfter.includes(pid) ? RECORDED_AT + 60_000 : RECORDED_AT - 1,
      readWrapperPid: () => wrapper,
      isAlive: (pid: number) => {
        if (
          signalledAt !== null &&
          dieAfterPolls !== null &&
          polls - signalledAt >= dieAfterPolls
        ) {
          alive.clear()
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
    const deadWrapper = { ...dead.input, readWrapperPid: () => 7 }
    expect((await stopDevDaemon(deadWrapper)).kind).toBe('stopped')
    expect(dead.signalled).toEqual([[100, 'SIGTERM']])
  })

  it('signals nothing when the recorded pid is alive but is not the daemon', async () => {
    const w = world({ wrapper: 50, startedAfter: [100] })
    expect(await stopDevDaemon(w.input)).toEqual({
      kind: 'stale',
      pid: 100,
      reason: expect.stringContaining('started after'),
    })
    expect(w.signalled).toEqual([])
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
    expect(await stopDevDaemon(w.input)).toEqual({ kind: 'timeout', pid: 100 })
  })
})
