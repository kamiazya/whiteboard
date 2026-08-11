// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useCreateCanvas } from './useCreateCanvas'

function options(overrides: Partial<Parameters<typeof useCreateCanvas>[0]> = {}) {
  return {
    workspaceId: 'ws_1',
    slug: 'canvas-a',
    canvases: [{ slug: 'canvas-a', updatedAt: '2026-04-23T00:00:00Z' }],
    isLocalMode: false,
    onCreateCanvas: undefined,
    onNavigateToCanvas: vi.fn(),
    daemonFetch: vi.fn(
      async () => new Response(JSON.stringify({ slug: 'untitled' }), { status: 200 }),
    ) as unknown as typeof globalThis.fetch,
    mountedRef: { current: true },
    ...overrides,
  }
}

describe('useCreateCanvas — immediate create', () => {
  it('exposes an in-flight busy flag while the create is pending', async () => {
    let resolveFetch: ((r: Response) => void) | undefined
    const daemonFetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve
        }),
    )
    const { result } = renderHook(() =>
      useCreateCanvas(options({ daemonFetch: daemonFetch as unknown as typeof globalThis.fetch })),
    )
    act(() => result.current.openNewCanvas())
    expect(result.current.newCanvasBusy).toBe(true)
    await act(async () =>
      resolveFetch?.(new Response(JSON.stringify({ slug: 'untitled' }), { status: 200 })),
    )
    expect(result.current.newCanvasBusy).toBe(false)
  })

  // Restores the dialog-era unmount-safety intent this diff had dropped without a successor:
  // a create that fails after the top bar unmounted must not setState into the void.
  it('does not set an error once mountedRef flips false mid-create', async () => {
    const mountedRef = { current: true }
    let rejectFetch: ((e: Error) => void) | undefined
    const daemonFetch = vi.fn(
      () =>
        new Promise<Response>((_r, reject) => {
          rejectFetch = reject
        }),
    )
    const { result } = renderHook(() =>
      useCreateCanvas(
        options({ mountedRef, daemonFetch: daemonFetch as unknown as typeof globalThis.fetch }),
      ),
    )
    act(() => result.current.openNewCanvas())
    mountedRef.current = false
    await act(async () => rejectFetch?.(new Error('boom')))
    expect(result.current.newCanvasError).toBeNull()
  })

  it('local mode hands off to onCreateCanvas without any fetch', async () => {
    const onCreateCanvas = vi.fn()
    const daemonFetch = vi.fn() as unknown as typeof globalThis.fetch
    const { result } = renderHook(() =>
      useCreateCanvas(options({ isLocalMode: true, onCreateCanvas, daemonFetch })),
    )
    await act(async () => result.current.openNewCanvas())
    expect(onCreateCanvas).toHaveBeenCalledTimes(1)
    expect(daemonFetch).not.toHaveBeenCalled()
  })

  it('daemon mode derives within the current group and POSTs it', async () => {
    const daemonFetch = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ slug: 'x' }), { status: 200 }),
    )
    const onNavigateToCanvas = vi.fn()
    const { result } = renderHook(() =>
      useCreateCanvas(
        options({
          slug: 'design/foo',
          canvases: [
            { slug: 'design/foo', updatedAt: '2026-04-23T00:00:00Z' },
            { slug: 'design/untitled', updatedAt: '2026-04-23T00:00:00Z' },
            { slug: 'untitled', updatedAt: '2026-04-23T00:00:00Z' },
          ],
          daemonFetch: daemonFetch as unknown as typeof globalThis.fetch,
          onNavigateToCanvas,
        }),
      ),
    )
    await act(async () => result.current.openNewCanvas())
    // design/untitled is taken INSIDE the group; the bare untitled outside it must not collide.
    expect(JSON.parse(String(daemonFetch.mock.calls[0]?.[1]?.body))).toEqual({
      slug: 'design/untitled-2',
    })
    expect(onNavigateToCanvas).toHaveBeenCalledWith('design/untitled-2')
  })

  // Intent carried over from the dialog-era "Enter twice issues one POST" test. The guard is a
  // ref, because state read from the handler closure is stale for a same-tick second call.
  it('two same-tick calls issue exactly one POST', async () => {
    let resolveFetch: ((r: Response) => void) | undefined
    const daemonFetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve
        }),
    )
    const { result } = renderHook(() =>
      useCreateCanvas(options({ daemonFetch: daemonFetch as unknown as typeof globalThis.fetch })),
    )
    act(() => {
      result.current.openNewCanvas()
      result.current.openNewCanvas()
    })
    expect(daemonFetch).toHaveBeenCalledTimes(1)
    await act(async () =>
      resolveFetch?.(new Response(JSON.stringify({ slug: 'untitled' }), { status: 200 })),
    )
  })

  // P-HTTP-005 intents, carried over verbatim from the dialog-era suite.
  it('surfaces the Problem Details title on failure', async () => {
    const daemonFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ title: 'Canvas already exists', status: 409 }), {
          status: 409,
        }),
    )
    const { result } = renderHook(() =>
      useCreateCanvas(options({ daemonFetch: daemonFetch as unknown as typeof globalThis.fetch })),
    )
    await act(async () => result.current.openNewCanvas())
    expect(result.current.newCanvasError).toBe('Canvas already exists')
  })

  it('never exposes body.message and falls back generically (P-HTTP-005)', async () => {
    const daemonFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ message: '/etc/secret leaked path' }), { status: 500 }),
    )
    const { result } = renderHook(() =>
      useCreateCanvas(options({ daemonFetch: daemonFetch as unknown as typeof globalThis.fetch })),
    )
    await act(async () => result.current.openNewCanvas())
    expect(result.current.newCanvasError).toBe('Failed to create canvas.')
  })

  it('never exposes Error.message when fetch throws (P-HTTP-005)', async () => {
    const daemonFetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED 127.0.0.1:3099 /home/user/.whiteboard')
    })
    const { result } = renderHook(() =>
      useCreateCanvas(options({ daemonFetch: daemonFetch as unknown as typeof globalThis.fetch })),
    )
    await act(async () => result.current.openNewCanvas())
    expect(result.current.newCanvasError).toBe('Failed to create canvas.')
  })

  it('falls back when the Problem Details title is a non-string (Zod parse guard)', async () => {
    const daemonFetch = vi.fn(
      async () => new Response(JSON.stringify({ title: 42 }), { status: 500 }),
    )
    const { result } = renderHook(() =>
      useCreateCanvas(options({ daemonFetch: daemonFetch as unknown as typeof globalThis.fetch })),
    )
    await act(async () => result.current.openNewCanvas())
    expect(result.current.newCanvasError).toBe('Failed to create canvas.')
  })
})
