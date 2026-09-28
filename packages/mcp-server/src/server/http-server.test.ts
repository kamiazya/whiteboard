import { createServer } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { socketFetch, testSocketPath } from '../shared/test-utils/socket-fetch.js'
import { type RunningServer, startHttpServer } from './http-server.js'

// Wiring this covers: startHttpServer must build the daemon's own
// WorkspaceReplicaKeyStore (ADR-0042/0043) from the post-migration db handle
// and thread it, together with `serverDeps`, into createApp — createApp only
// mounts the replica-key router when both are present. A unit test on createApp
// alone, or on createWorkspaceReplicaKeyStore in isolation, cannot see a
// composition-root wiring gap in the `db` handle or the mount condition.
describe('startHttpServer replica-key route wiring (ADR-0042/0043)', () => {
  let running: RunningServer | undefined

  afterEach(async () => {
    await running?.close()
    running = undefined
  })

  // An unregistered workspace 404s rather than answering an empty key, which
  // requires the router to be mounted AND `serverDeps.workspaceDocuments` to
  // be wired through.
  it('POST /api/workspaces/:workspaceId/replica-key answers 404 for an unregistered workspace on the real socket', async () => {
    const socketPath = testSocketPath()
    running = await startHttpServer({ socketPath })

    const res = await socketFetch(socketPath)('/api/workspaces/any-workspace/replica-key', {
      method: 'POST',
    })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({
      error: 'unknown_workspace',
      message: 'no such workspace: any-workspace',
    })
  })
})

// Wiring this covers: startHttpServer must construct exactly one file-gc
// sweeper and start it, and close() must stop it exactly once even if close()
// is (accidentally or deliberately) called twice -- the periodic sweep is
// otherwise invisible from outside the daemon (no HTTP surface), so only a
// test that drives the real startHttpServer/close() path can catch a
// regression where the sweeper is never started, started twice, or never
// stopped on shutdown.
describe('startHttpServer file-gc sweeper wiring', () => {
  let running: RunningServer | undefined

  afterEach(async () => {
    await running?.close()
    running = undefined
  })

  it('creates exactly one sweeper, starts it once, and close() stops it exactly once', async () => {
    const socketPath = testSocketPath()
    let factoryCalls = 0
    let startCalls = 0
    let stopCalls = 0
    const fileGcSweeperFactory = () => {
      factoryCalls += 1
      return {
        start: () => {
          startCalls += 1
        },
        tick: async () => {},
        stop: async () => {
          stopCalls += 1
        },
      }
    }

    running = await startHttpServer({ socketPath, fileGcSweeperFactory })

    const res = await socketFetch(socketPath)('/api/runtime/ping')
    expect(res.status).toBe(200)

    expect(factoryCalls).toBe(1)
    expect(startCalls).toBe(1)
    expect(stopCalls).toBe(0)

    await running.close()
    expect(stopCalls).toBe(1)

    // Double close must not stop the sweeper a second time.
    await running.close()
    expect(stopCalls).toBe(1)
  })

  // Regression for a close() that is invoked twice CONCURRENTLY (idle timeout
  // racing an explicit shutdown route, for example) rather than only after
  // the first call has fully resolved -- a naive `if (closing) return` guard
  // lets the second call resolve immediately while the listener is still
  // tearing down, which is materially worse now that
  // shutdown can also be waiting on an in-flight GC pass.
  it('two concurrent close() calls share one shutdown promise instead of the second resolving early', async () => {
    const socketPath = testSocketPath()
    let stopCalls = 0
    let resolveStop: (() => void) | undefined
    const stopGate = new Promise<void>((resolve) => {
      resolveStop = resolve
    })
    const fileGcSweeperFactory = () => ({
      start: () => {},
      tick: async () => {},
      stop: async () => {
        stopCalls += 1
        await stopGate
      },
    })

    running = await startHttpServer({ socketPath, fileGcSweeperFactory })
    const res = await socketFetch(socketPath)('/api/runtime/ping')
    expect(res.status).toBe(200)

    let firstResolved = false
    let secondResolved = false
    const first = running.close().then(() => {
      firstResolved = true
    })
    const second = running.close().then(() => {
      secondResolved = true
    })

    // Wait until the shared shutdown has actually REACHED the gated worker,
    // rather than counting microtask turns to get there: the registry runs
    // its workers in declaration order, so a fixed number of turns silently
    // stops being enough the moment another worker is declared ahead of this
    // one. Once inside the gate, neither call may resolve.
    while (stopCalls === 0) await new Promise((resolve) => setTimeout(resolve, 1))
    expect(firstResolved).toBe(false)
    expect(secondResolved).toBe(false)
    expect(stopCalls).toBe(1)

    resolveStop?.()
    await Promise.all([first, second])
    expect(firstResolved).toBe(true)
    expect(secondResolved).toBe(true)
    expect(stopCalls).toBe(1)
  })
})

// A socket that cannot be made safe stops the daemon rather than leaving it
// half-started: the background work it already armed is stopped again, so a
// losing start leaves no timer behind in whatever process hosts it.
describe('startHttpServer on a socket another daemon holds', () => {
  it('refuses to start, and stops the work it had already armed', async () => {
    const socketPath = testSocketPath()
    const occupier = createServer()
    await new Promise<void>((resolve) => occupier.listen(socketPath, resolve))
    let fileGcSweeperStopCalls = 0
    const fileGcSweeperFactory = () => ({
      start: () => {},
      tick: async () => {},
      stop: async () => {
        fileGcSweeperStopCalls += 1
      },
    })

    try {
      await expect(startHttpServer({ socketPath, fileGcSweeperFactory })).rejects.toThrow(
        'another daemon is already listening on this socket',
      )
      expect(fileGcSweeperStopCalls).toBe(1)
    } finally {
      await new Promise<void>((resolve) => occupier.close(() => resolve()))
    }
  })
})

describe('workspace tail wiring', () => {
  const ENV = 'WHITEBOARD_WORKSPACE_TAIL_MS'
  let running: Awaited<ReturnType<typeof startHttpServer>> | undefined
  let previous: string | undefined

  beforeEach(() => {
    previous = process.env[ENV]
  })

  afterEach(async () => {
    if (previous === undefined) delete process.env[ENV]
    else process.env[ENV] = previous
    await running?.close()
    running = undefined
  })

  function countingTailFactory() {
    const counts = { created: 0, started: 0, stopped: 0 }
    const factory = () => {
      counts.created += 1
      return {
        pollOnce: async () => {},
        start: () => {
          counts.started += 1
        },
        stop: async () => {
          counts.stopped += 1
        },
      }
    }
    return { counts, factory }
  }

  /**
   * The default is OFF, and this is the assertion that keeps it that way. A
   * tail running in every single-daemon install would poll the database
   * forever for a second instance nobody deployed, and nothing else here
   * would notice.
   */
  it('creates no tail when the interval is unset', async () => {
    delete process.env[ENV]
    const socketPath = testSocketPath()
    const { counts, factory } = countingTailFactory()
    running = await startHttpServer({
      socketPath,
      workspaceTailFactory: factory,
    })
    await socketFetch(socketPath)('/api/runtime/ping')
    expect(counts.created).toBe(0)
  })

  it('creates, starts and stops exactly one tail when the interval is set', async () => {
    process.env[ENV] = '250'
    const socketPath = testSocketPath()
    const { counts, factory } = countingTailFactory()
    running = await startHttpServer({
      socketPath,
      workspaceTailFactory: factory,
    })
    await socketFetch(socketPath)('/api/runtime/ping')
    expect(counts.created).toBe(1)
    expect(counts.started).toBe(1)
    expect(counts.stopped).toBe(0)

    await running.close()
    running = undefined
    expect(counts.stopped).toBe(1)
  })
})

/**
 * ADR-0021 decision 4's wiring. The scheduler's own tests cover when and
 * where; what only composition can answer is whether it is CONNECTED — and a
 * durability feature that is built and never started is the failure mode this
 * whole area exists to remove, since every unit test passes by calling it
 * directly.
 */
describe('startHttpServer: backup scheduler wiring', () => {
  const DIR_ENV = 'WHITEBOARD_BACKUP_DIR'
  let running: Awaited<ReturnType<typeof startHttpServer>> | undefined
  let previous: string | undefined

  beforeEach(() => {
    previous = process.env[DIR_ENV]
  })
  afterEach(async () => {
    if (previous === undefined) delete process.env[DIR_ENV]
    else process.env[DIR_ENV] = previous
    await running?.close()
    running = undefined
  })

  function countingSchedulerFactory() {
    const counts = { created: 0, started: 0, stopped: 0 }
    const seen: Array<string | null> = []
    const factory = (options: { backupDir: string | null }) => {
      counts.created += 1
      seen.push(options.backupDir)
      return {
        start: () => {
          counts.started += 1
        },
        stop: async () => {
          counts.stopped += 1
        },
        runOnceForTests: async () => {},
      }
    }
    return { counts, seen, factory }
  }

  /**
   * Constructed either way — the scheduler decides for itself that a null
   * destination means do nothing — but it must be told the destination is
   * absent rather than being handed a guessed one.
   */
  it('passes a null destination through when nothing is configured', async () => {
    delete process.env[DIR_ENV]
    const socketPath = testSocketPath()
    const { counts, seen, factory } = countingSchedulerFactory()
    running = await startHttpServer({
      socketPath,
      backupSchedulerFactory: factory as never,
    })
    await socketFetch(socketPath)('/api/runtime/ping')
    expect(counts.created).toBe(1)
    expect(seen).toEqual([null])
  })

  it('starts and stops exactly one scheduler when a destination is set', async () => {
    process.env[DIR_ENV] = '/srv/whiteboard-backups'
    const socketPath = testSocketPath()
    const { counts, seen, factory } = countingSchedulerFactory()
    running = await startHttpServer({
      socketPath,
      backupSchedulerFactory: factory as never,
    })
    await socketFetch(socketPath)('/api/runtime/ping')
    expect(counts.created).toBe(1)
    expect(counts.started).toBe(1)
    expect(counts.stopped).toBe(0)
    expect(seen).toEqual(['/srv/whiteboard-backups'])

    await running.close()
    running = undefined
    expect(counts.stopped).toBe(1)
  })
})
