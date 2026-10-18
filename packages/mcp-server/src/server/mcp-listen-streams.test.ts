import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { capListenStreams } from './mcp-listen-streams.js'

type Ending = 'end' | 'error'

/**
 * An app whose `/mcp` answers a listen with an event stream the test ends at
 * will — `x-user` names the caller, `x-answer: json` answers without a stream.
 */
function appCapped(caps: { perUser: number; total: number }) {
  const refusals: string[] = []
  const controllers: ReadableStreamDefaultController<Uint8Array>[] = []
  const app = new Hono()
  app.use(
    '/mcp',
    capListenStreams({
      caps,
      userOf: async (c) => c.req.header('x-user') ?? null,
      refused: (_userId, cap) => refusals.push(cap),
    }),
  )
  app.post('/mcp', (c) => {
    if (c.req.header('x-answer') === 'json') return c.json({ jsonrpc: '2.0', result: {}, id: 1 })
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controllers.push(controller)
      },
    })
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
  })
  const listen = (user: string, headers: Record<string, string> = {}) =>
    Promise.resolve(
      app.request('/mcp', {
        method: 'POST',
        headers: { 'x-user': user, 'mcp-method': 'subscriptions/listen', ...headers },
        body: '{}',
      }),
    )
  return { listen, refusals, controllers }
}

/** Reads `res` until it settles, so the wrapped stream sees its source end. */
async function drain(res: Response): Promise<void> {
  await res
    .text()
    .then(() => undefined)
    .catch(() => undefined)
}

describe('capListenStreams', () => {
  it('refuses past the per-user cap with 429, and counts each user apart', async () => {
    const { listen, refusals } = appCapped({ perUser: 2, total: 10 })
    expect((await listen('ada')).status).toBe(200)
    expect((await listen('ada')).status).toBe(200)
    const refused = await listen('ada')
    expect(refused.status).toBe(429)
    expect(await refused.json()).toMatchObject({ jsonrpc: '2.0', error: { code: -32000 } })
    expect((await listen('bob')).status).toBe(200)
    expect(refusals).toEqual(['per_user'])
  })

  it('refuses past the per-instance cap whoever asks', async () => {
    const { listen, refusals } = appCapped({ perUser: 5, total: 2 })
    expect((await listen('ada')).status).toBe(200)
    expect((await listen('bob')).status).toBe(200)
    expect((await listen('cy')).status).toBe(429)
    expect(refusals).toEqual(['total'])
  })

  it.for<Ending>(['end', 'error'])('gives the place back when a stream ends by %s', async (how) => {
    const { listen, controllers } = appCapped({ perUser: 1, total: 10 })
    const first = await listen('ada')
    expect((await listen('ada')).status).toBe(429)
    const reading = drain(first)
    if (how === 'end') controllers[0]?.close()
    else controllers[0]?.error(new Error('transport failed'))
    await reading
    expect((await listen('ada')).status).toBe(200)
  })

  it('gives the place back when the client cancels the stream', async () => {
    const { listen } = appCapped({ perUser: 1, total: 10 })
    const first = await listen('ada')
    await first.body?.cancel('client went away')
    expect((await listen('ada')).status).toBe(200)
  })

  it('takes no place for an answer that is not a stream', async () => {
    const { listen } = appCapped({ perUser: 1, total: 10 })
    expect((await listen('ada', { 'x-answer': 'json' })).status).toBe(200)
    expect((await listen('ada')).status).toBe(200)
  })

  it('counts only listen requests', async () => {
    const { listen } = appCapped({ perUser: 1, total: 10 })
    expect((await listen('ada')).status).toBe(200)
    expect((await listen('ada', { 'mcp-method': 'tools/call' })).status).toBe(200)
  })
})
