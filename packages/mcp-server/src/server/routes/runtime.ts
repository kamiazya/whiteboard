import { Hono } from 'hono'
import { runtimeStatusResponseSchema } from '../../shared/api-contracts/runtime.js'
import type { RuntimeStatusResponse } from '../../shared/api-contracts/runtime.js'
import { isAuthorized } from './auth.js'
import type { McpHttpAuthStrategy } from '../security/mcp-auth.js'

export interface RuntimeRouterOptions {
  token?: string
  mcpAuth?: McpHttpAuthStrategy
  touch: () => void
  getStatus: () => RuntimeStatusResponse
  shutdown: () => Promise<void>
}

export function createRuntimeRouter(options: RuntimeRouterOptions) {
  const app = new Hono()

  app.get('/api/runtime/ping', (c) => {
    return c.json({ ok: true, pid: process.pid })
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
    return c.json(runtimeStatusResponseSchema.parse(options.getStatus()))
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

  return app
}
