// What the /mcp ROUTER is responsible for, now that it is a module rather
// than a closure inside `createApp`: it claims exactly `/mcp`, it hands a
// modern request to the SDK handler it was given, and it answers with that
// handler's response unchanged. The protocol itself is the SDK's and is
// covered end to end by `scripts/smoke/mcp-http-convergence-smoke.mjs`.

import { describe, expect, it, vi } from 'vitest'
import { createMcpRouter, type McpRouterDeps } from './mcp.js'

function routerWith(fetchImpl: (request: Request) => Promise<Response>) {
  const fetch = vi.fn(fetchImpl)
  const deps = {
    modernMcpHandler: { fetch } as unknown as McpRouterDeps['modernMcpHandler'],
    pairingLinkContext: undefined,
    pairingUnavailableReason: 'no-daemon-base-url',
  } satisfies McpRouterDeps
  return { router: createMcpRouter(deps), fetch }
}

const initialize = () =>
  new Request('http://d/mcp', {
    method: 'POST',
    // The header pair a modern client sends; without it the SDK reads the
    // request as legacy and this router never reaches the handler.
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  })

describe('the /mcp router', () => {
  it('hands a modern request to the SDK handler and answers with its response', async () => {
    const { router, fetch } = routerWith(async () => new Response('{"ok":true}', { status: 207 }))

    const response = await router.fetch(initialize())

    expect(fetch).toHaveBeenCalledTimes(1)
    // 207 is not a status anything here would invent, so returning it is
    // what says the handler's answer travels back untouched.
    expect(response.status).toBe(207)
    expect(await response.text()).toBe('{"ok":true}')
  })

  it('reads the body WITHOUT consuming it, so the handler still gets one', async () => {
    // The router parses the payload to decide modern-vs-legacy and to log an
    // initialize; a clone is what keeps the stream readable downstream. A
    // handler receiving an empty body is the failure this pins.
    let seen: unknown
    const { router } = routerWith(async (request) => {
      seen = await request.json()
      return new Response('{}', { status: 200 })
    })

    await router.fetch(initialize())

    expect(seen).toMatchObject({ method: 'initialize', id: 1 })
  })

  it('claims /mcp and nothing else', async () => {
    const { router, fetch } = routerWith(async () => new Response('{}'))

    expect((await router.fetch(new Request('http://d/api/runtime/ping'))).status).toBe(404)
    expect(fetch).not.toHaveBeenCalled()
  })
})
