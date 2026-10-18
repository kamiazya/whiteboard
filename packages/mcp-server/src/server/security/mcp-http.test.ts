import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'

import { createCredentialResolver } from './credential-resolver.js'
import { mintMacaroon } from './macaroon.js'
import { createLocalTokenMcpHttpAuthStrategy } from './mcp-auth.js'
import { gatedByMembership } from './mcp-caller.js'
import { createMcpHttpAuthMiddleware } from './mcp-http.js'

/**
 * The middleware's job is carrying the REQUEST into the strategy. The
 * strategy's own tests build the context by hand, so they cannot see a field
 * this layer forgets to pass.
 */
describe('createMcpHttpAuthMiddleware carries the request into the strategy', () => {
  const app = () => {
    const hono = new Hono()
    hono.use(
      '/mcp',
      createMcpHttpAuthMiddleware(
        createLocalTokenMcpHttpAuthStrategy({
          resolver: createCredentialResolver({ daemonToken: 'secret' }),
        }),
      ),
    )
    hono.post('/mcp', (c) => c.json({ reached: true }))
    return hono
  }

  it('passes the Authorization header through, so the daemon token is admitted', async () => {
    const res = await app().request('/mcp', {
      method: 'POST',
      headers: { authorization: 'Bearer secret' },
    })
    expect(res.status).toBe(200)
    // The handler's body, not only its status: a refusal built with no
    // status would answer 200 too.
    expect(await res.json()).toEqual({ reached: true })
  })

  it('answers 401 with no credential', async () => {
    const res = await app().request('/mcp', { method: 'POST' })
    expect(res.status).toBe(401)
  })
})

/**
 * A macaroon is a NARROW credential: `mcp:call` opens the endpoint, and each
 * tool still needs the scope its `/api` twin does — on the local daemon as on
 * server mode. The daemon token holds every scope.
 */
describe('the local daemon’s /mcp holds a scoped grant to each tool’s scope', () => {
  const ROOT_KEY = new Uint8Array(32).fill(9)
  const index = {
    resolveWorkspace: async () => null,
    createWorkspace: async () => {
      throw new Error('not reached')
    },
  }
  const tools = gatedByMembership(
    {
      edit: { name: 'wb_canvas_edit', execute: async (_input: never) => 'edited' },
      read: { name: 'wb_document_get', execute: async (_input: never) => 'read' },
    },
    index as never,
  )
  const app = () => {
    const hono = new Hono()
    hono.use(
      '/mcp/*',
      createMcpHttpAuthMiddleware(
        createLocalTokenMcpHttpAuthStrategy({
          resolver: createCredentialResolver({ daemonToken: 'secret', macaroonRootKey: ROOT_KEY }),
        }),
      ),
    )
    hono.post('/mcp/:tool', async (c) => {
      const tool = tools[c.req.param('tool') as 'edit' | 'read']
      try {
        return c.json({ result: await tool.execute({ workspaceId: 'ws' } as never) })
      } catch (err) {
        return c.json({ refused: (err as Error).message })
      }
    })
    return hono
  }
  const call = async (tool: string, bearer: string) =>
    (
      await app().request(`/mcp/${tool}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${bearer}` },
      })
    ).json()
  const readOnly = () =>
    mintMacaroon({
      rootKey: ROOT_KEY,
      tokenId: 'reader',
      caveats: [{ kind: 'scope', scopes: ['mcp:call', 'canvas:read'] }],
    })

  it('refuses a write tool to a macaroon scoped for reading', async () => {
    expect(await call('edit', await readOnly())).toEqual({
      refused: expect.stringContaining('insufficient_scope'),
    })
  })

  it('runs a tool the macaroon’s scopes reach', async () => {
    expect(await call('read', await readOnly())).toEqual({ result: 'read' })
  })

  it('reaches the tools only through the middleware', async () => {
    const res = await app().request('/mcp/read', { method: 'POST' })
    expect(res.status).toBe(401)
  })

  it('runs every tool for the daemon token', async () => {
    expect(await call('edit', 'secret')).toEqual({ result: 'edited' })
  })
})
