/**
 * What the daemon-addressed fetch does to a request: it resolves the address
 * and nothing else. The page holds no daemon credential, so no header is added
 * whichever origin the request resolves to.
 */
import { describe, expect, it, vi } from 'vitest'
import { jsonResponse } from '../test-utils/json-response.js'
import { createDaemonFetch } from './daemon-fetch.js'

const DAEMON = 'http://127.0.0.1:3099'

function setup() {
  const network = vi.fn<typeof fetch>().mockImplementation(async () => jsonResponse({}))
  const daemonFetch = createDaemonFetch(DAEMON, network)
  const lastCall = () => {
    const [url, init] = network.mock.lastCall ?? []
    return { url: String(url), init, auth: new Headers(init?.headers).get('Authorization') }
  }
  return { daemonFetch, lastCall }
}

describe('the daemon-addressed fetch', () => {
  it('resolves a relative path against the daemon', async () => {
    const { daemonFetch, lastCall } = setup()
    await daemonFetch('/api/x')
    expect(lastCall().url).toBe(`${DAEMON}/api/x`)
  })

  it.each([
    ['the daemon origin', `${DAEMON}/api/x`],
    ['another port on the same host', 'http://127.0.0.1:8080/x'],
    ['an external host', 'https://example.com/x'],
  ])('sends %s untouched and adds no Authorization header', async (_label, url) => {
    const { daemonFetch, lastCall } = setup()
    await daemonFetch(url)
    expect(lastCall()).toMatchObject({ url, auth: null })
  })

  it('adds no Authorization header to a Request object and keeps its method and headers', async () => {
    const { daemonFetch, lastCall } = setup()
    await daemonFetch(
      new Request(`${DAEMON}/api/x`, { method: 'DELETE', headers: { 'x-trace': 'abc' } }),
    )
    const { init, auth } = lastCall()
    expect(auth).toBeNull()
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
