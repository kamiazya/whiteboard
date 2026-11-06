/**
 * The 400 a malformed workspace address answers, from the one place that
 * writes it. The route suites pin the same body per route; this pins the
 * helper itself, so a change to the contract names the helper's test first.
 */
import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'

vi.mock('./store/document-store.js', async () => {
  const { matchesWorkspaceLookup } = await import('@kamiazya/whiteboard-ports')
  const rows = [{ workspaceId: '01KW0R7X0REFV7TSXJ14JPBV6Z', segment: 'alpha' }]
  return {
    workspaceRegistry: () => ({
      listWorkspaces: async () => rows,
      findWorkspace: async (lookup: Parameters<typeof matchesWorkspaceLookup>[1]) =>
        rows.find((row) => matchesWorkspaceLookup(row, lookup)) ?? null,
    }),
  }
})

const { parseWorkspaceHandle, refuseMalformedHandle } = await import('./workspace-handle.js')

function appOver() {
  const app = new Hono()
  app.get('/parse/:handle', async (c) => {
    const parsed = await parseWorkspaceHandle(c, c.req.param('handle'))
    return 'refusal' in parsed ? parsed.refusal : c.json({ workspaceId: parsed.workspaceId })
  })
  app.get('/refuse/:handle', (c) => refuseMalformedHandle(c, c.req.param('handle')) ?? c.text('ok'))
  return app
}

describe('parseWorkspaceHandle', () => {
  it('refuses a malformed handle with the { error, message } 400', async () => {
    const res = await appOver().request('/parse/bad.handle')
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: 'invalid_workspace_id',
      message:
        'Invalid workspaceId "bad.handle": a workspace is addressed by its canonical id or by a segment (ASCII letters, digits and interior hyphens)',
    })
  })

  it('resolves a segment to the canonical id', async () => {
    const res = await appOver().request('/parse/alpha')
    expect(await res.json()).toEqual({ workspaceId: '01KW0R7X0REFV7TSXJ14JPBV6Z' })
  })

  it('passes a handle matching nothing through unchanged', async () => {
    const res = await appOver().request('/parse/nothing-here')
    expect(await res.json()).toEqual({ workspaceId: 'nothing-here' })
  })
})

describe('refuseMalformedHandle', () => {
  it('answers null for a well-formed handle, without consulting the registry', async () => {
    const res = await appOver().request('/refuse/alpha')
    expect(await res.text()).toBe('ok')
  })

  it('answers the same 400 body as parseWorkspaceHandle', async () => {
    const [a, b] = await Promise.all([
      appOver().request('/parse/bad.handle'),
      appOver().request('/refuse/bad.handle'),
    ])
    expect(b.status).toBe(400)
    expect(await b.json()).toEqual(await a.json())
  })
})
