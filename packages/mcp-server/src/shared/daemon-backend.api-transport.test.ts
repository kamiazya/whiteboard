import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BinaryFileDataLike } from './canvas-backend-contract.js'
import { DaemonBackend } from './daemon-backend.js'

// getFile/putFile normally go through the module-level apiFetch, which only
// resolves relative paths against the current page origin. Cross-origin
// daemon pairing (apps/web talking to a loopback daemon on a different
// origin) needs those calls to hit the daemon's origin instead, so
// DaemonBackend accepts an optional apiTransport override.
describe('DaemonBackend apiTransport', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('getFile uses the injected apiTransport.fetch with a full daemon-origin URL', async () => {
    const injectedFetch = vi.fn().mockResolvedValue(new Response(new Blob(['x']), { status: 200 }))

    const backend = new DaemonBackend('ws-1', 'canvas-1', 'https://web.example.com/', {
      fetch: injectedFetch,
    })

    await backend.getFile('file-1')

    expect(injectedFetch).toHaveBeenCalledTimes(1)
    const [url] = injectedFetch.mock.calls[0] as [string]
    expect(url).toBe('/api/w/ws-1/canvas/canvas-1/file/file-1')
    // The module-level fetch (used by the default same-origin apiFetch) must
    // not be touched when an apiTransport override is supplied.
    expect(fetch).not.toHaveBeenCalled()
  })

  it('putFile passes the injected apiTransport.fetch through to uploadFiles', async () => {
    const injectedFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))

    const backend = new DaemonBackend('ws-1', 'canvas-1', 'https://web.example.com/', {
      fetch: injectedFetch,
    })

    const entries: [string, BinaryFileDataLike][] = [
      [
        'file-a',
        {
          id: 'file-a',
          mimeType: 'image/png',
          dataURL: 'data:image/png;base64,aGVsbG8=',
          created: Date.now(),
        },
      ],
    ]
    const onSuccess = vi.fn()

    await backend.putFile(entries, onSuccess)

    expect(injectedFetch).toHaveBeenCalledTimes(1)
    expect(onSuccess).toHaveBeenCalledWith('file-a')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('getFile falls back to the module-level apiFetch when no apiTransport is supplied', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(new Blob(['x']), { status: 200 }))

    const backend = new DaemonBackend('ws-1', 'canvas-1', 'https://web.example.com/')

    await backend.getFile('file-1')

    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('putFile falls back to the module-level apiFetch when no apiTransport is supplied', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 204 }))

    const backend = new DaemonBackend('ws-1', 'canvas-1', 'https://web.example.com/')

    const entries: [string, BinaryFileDataLike][] = [
      [
        'file-a',
        {
          id: 'file-a',
          mimeType: 'image/png',
          dataURL: 'data:image/png;base64,aGVsbG8=',
          created: Date.now(),
        },
      ],
    ]
    const onSuccess = vi.fn()

    await backend.putFile(entries, onSuccess)

    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/w/ws-1/canvas/canvas-1/file/file-a')
    expect(init.method).toBe('PUT')
    expect(onSuccess).toHaveBeenCalledWith('file-a')
  })
})
