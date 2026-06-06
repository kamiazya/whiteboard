import { Hono } from 'hono'
import { DATA_DIR } from '../config.js'
import { purgeOldDaemonLogs } from '../../daemon/log-rotation.js'
import type { RuntimeStatus } from '../http-server.js'
import { daemonPingResponseSchema } from '../../shared/api-contracts/runtime.js'
import { readLatestCompactedAt } from '../store/canvas-store.js'
import { isAuthorized } from './auth.js'
import { computeStorageReport } from './runtime-storage.js'
import type { McpHttpAuthStrategy } from '../security/mcp-auth.js'

export interface RuntimeRouterOptions {
  token?: string
  mcpAuth?: McpHttpAuthStrategy
  touch: () => void
  getStatus: () => RuntimeStatus
  shutdown: () => Promise<void>
}

export function createRuntimeRouter(options: RuntimeRouterOptions) {
  const app = new Hono()

  app.get('/api/runtime/ping', (c) => {
    return c.json(daemonPingResponseSchema.parse({ ok: true, pid: process.pid }))
  })

  app.use('/api/runtime/*', async (c, next) => {
    if (c.req.path === '/api/runtime/ping') return next()
    if (!isAuthorized(c.req.header('authorization'), options.token)) {
      return c.json({ error: 'unauthorized' }, 401)
    }
    return next()
  })

  app.get('/api/runtime/status', (c) => {
    options.touch()
    return c.json(options.getStatus())
  })

  app.post('/api/runtime/touch', (c) => {
    options.touch()
    return c.json({ ok: true })
  })

  app.post('/api/runtime/shutdown', (c) => {
    options.touch()
    setTimeout(() => {
      void options.shutdown()
    }, 0)
    return c.json({ ok: true })
  })

  // Storage usage report. Cheap stat()-only walk of DATA_DIR; nothing is cached.
  // `lastAutoCompactedAt` is the freshest auto-Optimize timestamp across
  // every canvas, so the UI can surface "Auto-optimised Ns ago" without
  // a separate round trip.
  app.get('/api/runtime/storage', async (c) => {
    options.touch()
    const report = await computeStorageReport(DATA_DIR)
    const lastAutoCompactedAt = await readLatestCompactedAt()
    return c.json({ ...report, lastAutoCompactedAt })
  })

  // Manual override of the daemon-log rotation. The daemon also runs
  // purgeOldDaemonLogs fire-and-forget on every spawn, but exposing this
  // route lets the Storage tab's Logs row show a Cleanup affordance for
  // users who want immediate disk reclamation without restarting.
  //
  // Defense-in-depth on auth: the per-router middleware above also gates
  // this path, but the global daemon-mutation middleware in app.ts
  // explicitly skips /api/runtime/*, so this route is one middleware
  // refactor away from being world-callable. Re-check the bearer in the
  // handler so the file-deletion side effect is never reached without it.
  app.post('/api/runtime/logs/prune', async (c) => {
    if (!isAuthorized(c.req.header('authorization'), options.token)) {
      return c.json({ error: 'unauthorized' }, 401)
    }
    options.touch()
    const result = await purgeOldDaemonLogs(DATA_DIR)
    return c.json(result)
  })

  return app
}
