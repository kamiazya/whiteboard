/**
 * Where the daemon's bearer goes. The credential is attached to a request
 * only when its resolved URL has the daemon's EXACT origin — scheme, host and
 * port — because another port or scheme on the same host is a different
 * process that may have claimed it.
 */
import { describe, expect, it, vi } from 'vitest'
import { createDaemonFetch } from './daemon-auth-fetch.js'

const DAEMON = 'http://127.0.0.1:3099'

function setup(token: string | (() => string | undefined) | null = 'secret') {
  const network = vi.fn<typeof fetch>().mockImplementation(async () => new Response('{}'))
  const daemonFetch = createDaemonFetch(DAEMON, token ?? undefined, network)
  const lastCall = () => {
    const [url, init] = network.mock.calls[0] ?? []
    return { url: String(url), init, auth: new Headers(init?.headers).get('Authorization') }
  }
  return { daemonFetch, lastCall }
}

describe('the daemon bearer destination', () => {
  it('attaches the bearer to the daemon origin', async () => {
    const { daemonFetch, lastCall } = setup()
    await daemonFetch(`${DAEMON}/api/x`)
    expect(lastCall().auth).toBe('Bearer secret')
  })

  it('resolves a relative path against the daemon and attaches the bearer', async () => {
    const { daemonFetch, lastCall } = setup()
    await daemonFetch('/api/x')
    expect(lastCall()).toMatchObject({ url: `${DAEMON}/api/x`, auth: 'Bearer secret' })
  })

  it('reads a rotated token on each call when the credential is a function', async () => {
    let current: string | undefined = 'first'
    const { daemonFetch, lastCall } = setup(() => current)
    current = 'second'
    await daemonFetch('/api/x')
    expect(lastCall().auth).toBe('Bearer second')
  })

  it('sends no Authorization header when there is no token', async () => {
    const { daemonFetch, lastCall } = setup(null)
    await daemonFetch('/api/x')
    expect(lastCall().auth).toBeNull()
  })

  it.each([
    ['another port on the same host', 'http://127.0.0.1:8080/x'],
    ['another scheme on the same host', 'https://127.0.0.1:3099/x'],
    ['the same port on another host', 'http://localhost:3099/x'],
    ['an external host', 'https://example.com/x'],
  ])('does not attach the bearer to %s', async (_label, url) => {
    const { daemonFetch, lastCall } = setup()
    await daemonFetch(url)
    expect(lastCall()).toMatchObject({ url, auth: null })
  })

  it('does not attach the bearer to a Request object that points at another origin', async () => {
    const { daemonFetch, lastCall } = setup()
    await daemonFetch(new Request('http://127.0.0.1:8080/x'))
    expect(lastCall()).toMatchObject({ url: 'http://127.0.0.1:8080/x', auth: null })
  })

  it('attaches the bearer to a Request object at the daemon origin and keeps its method and headers', async () => {
    const { daemonFetch, lastCall } = setup()
    await daemonFetch(
      new Request(`${DAEMON}/api/x`, { method: 'DELETE', headers: { 'x-trace': 'abc' } }),
    )
    const { init, auth } = lastCall()
    expect(auth).toBe('Bearer secret')
    expect(init?.method).toBe('DELETE')
    expect(new Headers(init?.headers).get('x-trace')).toBe('abc')
  })

  it('carries a Request body through to the rebuilt request, and lets an init body win', async () => {
    const carried = setup()
    await carried.daemonFetch(
      new Request(`${DAEMON}/api/x`, { method: 'POST', body: 'from-request' }),
    )
    const stream = carried.lastCall().init?.body
    expect(stream).toBeInstanceOf(ReadableStream)
    expect(await new Response(stream as ReadableStream).text()).toBe('from-request')
    expect(carried.lastCall().init).toMatchObject({ duplex: 'half' })

    const overridden = setup()
    await overridden.daemonFetch(
      new Request(`${DAEMON}/api/x`, { method: 'POST', body: 'from-request' }),
      { body: 'from-init' },
    )
    expect(overridden.lastCall().init?.body).toBe('from-init')
  })

  it('marks a streamed init body as half-duplex even when the Request carried none', async () => {
    const { daemonFetch, lastCall } = setup()
    const stream = new Response('streamed').body as ReadableStream
    await daemonFetch(new Request(`${DAEMON}/api/x`, { method: 'POST' }), { body: stream })
    expect(lastCall().init).toMatchObject({ body: stream, duplex: 'half' })
  })

  it('sends no body for a GET Request', async () => {
    const { daemonFetch, lastCall } = setup()
    await daemonFetch(new Request(`${DAEMON}/api/x`))
    const { init } = lastCall()
    expect(init?.body).toBeUndefined()
    expect(init).not.toHaveProperty('duplex')
  })
})
