import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_DAEMON_BASE_URL, probeDaemon } from './daemon-probe.js'

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

describe('probeDaemon', () => {
  beforeEach(() => {
    sessionStorage.clear()
    vi.restoreAllMocks()
  })

  it('returns detected with instanceId on a valid 200 response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true, instanceId: 'inst-1' }))

    const result = await probeDaemon(DEFAULT_DAEMON_BASE_URL, { fetch: fetchMock })

    expect(result).toEqual({ detected: true, instanceId: 'inst-1' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url] = fetchMock.mock.calls[0] as [string]
    expect(url).toBe(`${DEFAULT_DAEMON_BASE_URL}/api/runtime/ping`)
  })

  it('returns not-detected with reason timeout when the fetch never resolves', async () => {
    vi.useFakeTimers()
    try {
      const fetchMock = vi.fn().mockImplementation(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(new DOMException('Aborted', 'AbortError'))
            })
          }),
      )

      const promise = probeDaemon(DEFAULT_DAEMON_BASE_URL, {
        fetch: fetchMock,
        timeoutMs: 2000,
      })
      await vi.advanceTimersByTimeAsync(2000)
      const result = await promise

      expect(result).toEqual({ detected: false, reason: 'timeout' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('returns not-detected with reason http-error on a non-2xx response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('nope', { status: 500 }))

    const result = await probeDaemon(DEFAULT_DAEMON_BASE_URL, { fetch: fetchMock })

    expect(result).toEqual({ detected: false, reason: 'http-error' })
  })

  it('returns not-detected with reason malformed on a payload that fails Zod validation', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: false }))

    const result = await probeDaemon(DEFAULT_DAEMON_BASE_URL, { fetch: fetchMock })

    expect(result).toEqual({ detected: false, reason: 'malformed' })
  })

  it('returns not-detected with reason network when fetch rejects with a network error', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))

    const result = await probeDaemon(DEFAULT_DAEMON_BASE_URL, { fetch: fetchMock })

    expect(result).toEqual({ detected: false, reason: 'network' })
  })

  it('never throws and never logs to the console', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error')
    const consoleWarnSpy = vi.spyOn(console, 'warn')
    const fetchMock = vi.fn().mockRejectedValue(new Error('boom'))

    await expect(probeDaemon(DEFAULT_DAEMON_BASE_URL, { fetch: fetchMock })).resolves.toEqual({
      detected: false,
      reason: 'network',
    })
    expect(consoleErrorSpy).not.toHaveBeenCalled()
    expect(consoleWarnSpy).not.toHaveBeenCalled()
  })

  it('memoizes a successful result in sessionStorage — a second call does not refetch', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true, instanceId: 'inst-1' }))

    const first = await probeDaemon(DEFAULT_DAEMON_BASE_URL, { fetch: fetchMock })
    const second = await probeDaemon(DEFAULT_DAEMON_BASE_URL, { fetch: fetchMock })

    expect(first).toEqual({ detected: true, instanceId: 'inst-1' })
    expect(second).toEqual({ detected: true, instanceId: 'inst-1' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('forceRecheck bypasses the sessionStorage memo and fetches again', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true, instanceId: 'inst-1' }))

    await probeDaemon(DEFAULT_DAEMON_BASE_URL, { fetch: fetchMock })
    await probeDaemon(DEFAULT_DAEMON_BASE_URL, { fetch: fetchMock, forceRecheck: true })

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('treats a corrupt sessionStorage memo entry as absent and refetches', async () => {
    sessionStorage.setItem(`whiteboard:daemon-probe:${DEFAULT_DAEMON_BASE_URL}`, 'not-json{{{')
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true, instanceId: 'inst-1' }))

    const result = await probeDaemon(DEFAULT_DAEMON_BASE_URL, { fetch: fetchMock })

    expect(result).toEqual({ detected: true, instanceId: 'inst-1' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('dedupes concurrent overlapping calls for the same base URL into a single fetch', async () => {
    let resolveFetch!: (value: Response) => void
    const fetchMock = vi.fn().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve
        }),
    )

    const first = probeDaemon(DEFAULT_DAEMON_BASE_URL, { fetch: fetchMock })
    const second = probeDaemon(DEFAULT_DAEMON_BASE_URL, { fetch: fetchMock })

    resolveFetch(jsonResponse({ ok: true, instanceId: 'inst-1' }))
    const [firstResult, secondResult] = await Promise.all([first, second])

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(firstResult).toEqual({ detected: true, instanceId: 'inst-1' })
    expect(secondResult).toEqual({ detected: true, instanceId: 'inst-1' })
  })

  it('does not dedupe concurrent calls for different base URLs', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true, instanceId: 'inst-1' }))

    await Promise.all([
      probeDaemon('http://127.0.0.1:3099', { fetch: fetchMock }),
      probeDaemon('http://127.0.0.1:4000', { fetch: fetchMock }),
    ])

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
