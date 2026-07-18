import { readDaemonTokenOnce, resetTokenStoreForTests } from '@kamiazya/whiteboard-mcp/api-client'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clear as clearSecretStore, load, save } from '../lib/reconnect-credential-store.js'
import { resetSilentReconnectForTests, useSilentReconnect } from './useSilentReconnect.js'

const ORIGIN = 'http://localhost:3099'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

afterEach(() => {
  clearSecretStore()
  resetSilentReconnectForTests()
  resetTokenStoreForTests()
  vi.restoreAllMocks()
})

describe('useSilentReconnect', () => {
  it('stays idle and makes zero fetches when disabled', async () => {
    save(ORIGIN, 'secret-1')
    const fetchMock = vi.fn()
    const { result } = renderHook(() =>
      useSilentReconnect({ enabled: false, origin: ORIGIN, fetchImpl: fetchMock }),
    )
    expect(result.current).toEqual({ status: 'idle' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('stays idle and makes zero fetches when there is no stored secret', async () => {
    const fetchMock = vi.fn()
    const { result } = renderHook(() =>
      useSilentReconnect({ enabled: true, origin: ORIGIN, fetchImpl: fetchMock }),
    )
    expect(result.current).toEqual({ status: 'idle' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('happy path: connecting -> connected, persists rotated secret, seeds the token store', async () => {
    save(ORIGIN, 'secret-1')
    const fetchMock = vi.fn(async () =>
      jsonResponse({ token: 'daemon-token', reconnectSecret: 'secret-2', expiresInDays: 30 }),
    )
    const { result } = renderHook(() =>
      useSilentReconnect({ enabled: true, origin: ORIGIN, fetchImpl: fetchMock }),
    )
    expect(result.current).toEqual({ status: 'connecting' })

    await waitFor(() => expect(result.current.status).toBe('connected'))
    expect(result.current).toEqual({ status: 'connected', token: 'daemon-token' })
    expect(load(ORIGIN)).toBe('secret-2')
    expect(readDaemonTokenOnce()).toBe('daemon-token')
  })

  it('403 with the stored secret unchanged clears it and falls to failed(rejected)', async () => {
    save(ORIGIN, 'secret-1')
    const fetchMock = vi.fn(async () => jsonResponse({ error: 'unauthorized' }, 403))
    const { result } = renderHook(() =>
      useSilentReconnect({ enabled: true, origin: ORIGIN, fetchImpl: fetchMock }),
    )

    await waitFor(() => expect(result.current.status).toBe('failed'))
    expect(result.current).toEqual({ status: 'failed', reason: 'rejected' })
    expect(load(ORIGIN)).toBeNull()
  })

  it('403 where the store now holds a different secret retries once and can still succeed', async () => {
    save(ORIGIN, 'secret-1')
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization
      if (auth === 'Bearer secret-1') {
        // Simulate a concurrent tab winning the race and rotating the
        // secret out from under this attempt before the 403 is even
        // observed by this caller.
        save(ORIGIN, 'secret-winner')
        return jsonResponse({ error: 'unauthorized' }, 403)
      }
      return jsonResponse({ token: 'daemon-token', reconnectSecret: 'secret-3', expiresInDays: 30 })
    })

    const { result } = renderHook(() =>
      useSilentReconnect({ enabled: true, origin: ORIGIN, fetchImpl: fetchMock }),
    )

    await waitFor(() => expect(result.current.status).toBe('connected'))
    expect(result.current).toEqual({ status: 'connected', token: 'daemon-token' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(load(ORIGIN)).toBe('secret-3')
  })

  it('network error keeps the stored secret and reports failed(network)', async () => {
    save(ORIGIN, 'secret-1')
    const fetchMock = vi.fn(async () => {
      throw new Error('offline')
    })
    const { result } = renderHook(() =>
      useSilentReconnect({ enabled: true, origin: ORIGIN, fetchImpl: fetchMock }),
    )

    await waitFor(() => expect(result.current.status).toBe('failed'))
    expect(result.current).toEqual({ status: 'failed', reason: 'network' })
    expect(load(ORIGIN)).toBe('secret-1')
  })

  it('StrictMode-style double-mount for the same (origin, secret) makes exactly one network call', async () => {
    save(ORIGIN, 'secret-1')
    const fetchMock = vi.fn(async () =>
      jsonResponse({ token: 'daemon-token', reconnectSecret: 'secret-2', expiresInDays: 30 }),
    )
    const first = renderHook(() =>
      useSilentReconnect({ enabled: true, origin: ORIGIN, fetchImpl: fetchMock }),
    )
    // Second concurrent "mount" for the identical key should share the
    // in-flight promise rather than firing a second request.
    const second = renderHook(() =>
      useSilentReconnect({ enabled: true, origin: ORIGIN, fetchImpl: fetchMock }),
    )

    await waitFor(() => expect(first.result.current.status).toBe('connected'))
    await waitFor(() => expect(second.result.current.status).toBe('connected'))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('a late completion after disable does not flip UI state but still persists the rotated secret', async () => {
    save(ORIGIN, 'secret-1')
    let resolveFetch: ((value: Response) => void) | undefined
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve
        }),
    )
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useSilentReconnect({ enabled, origin: ORIGIN, fetchImpl: fetchMock }),
      { initialProps: { enabled: true } },
    )
    expect(result.current).toEqual({ status: 'connecting' })

    rerender({ enabled: false })
    expect(result.current).toEqual({ status: 'idle' })

    await act(async () => {
      resolveFetch?.(
        jsonResponse({ token: 'daemon-token', reconnectSecret: 'secret-2', expiresInDays: 30 }),
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    // UI state is unaffected by the stale generation...
    expect(result.current).toEqual({ status: 'idle' })
    // ...but the rotation was still persisted.
    await waitFor(() => expect(load(ORIGIN)).toBe('secret-2'))
  })
})
