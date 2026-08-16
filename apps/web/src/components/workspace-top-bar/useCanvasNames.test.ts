import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { CanvasInfo } from './types'
import { useCanvasNames } from './useCanvasNames'

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    json: async () => body,
  } as Response
}

describe('useCanvasNames', () => {
  it('parses a well-formed /names response into effectiveNames', async () => {
    const daemonFetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ canvases: { foo: 'Foo Canvas' }, pinned: ['foo'] }))
    const { result } = renderHook(() =>
      useCanvasNames({
        workspaceId: 'ws1',
        canvases: [],
        isLocalMode: false,
        daemonFetch,
      }),
    )
    await waitFor(() => {
      expect(result.current.effectiveNames.canvases.foo).toBe('Foo Canvas')
    })
    expect(result.current.effectiveNames.pinned).toEqual(['foo'])
  })

  it('falls back to empty names when the /names response fails schema validation', async () => {
    const daemonFetch = vi.fn().mockResolvedValue(jsonResponse({ canvases: 'not-an-object' }))
    const { result } = renderHook(() =>
      useCanvasNames({
        workspaceId: 'ws1',
        canvases: [],
        isLocalMode: false,
        daemonFetch,
      }),
    )
    // The malformed payload throws inside workspaceNamesSchema.parse, caught by
    // the hook's best-effort try/catch — state stays at the initial empty value.
    await waitFor(() => {
      expect(daemonFetch).toHaveBeenCalled()
    })
    expect(result.current.effectiveNames).toEqual({ canvases: {}, pinned: [] })
  })

  it('derives local-mode names from the canvases array instead of fetching', () => {
    const daemonFetch = vi.fn()
    const canvases: CanvasInfo[] = [{ path: 'foo', updatedAt: '2026-01-01', name: 'Foo Local' }]
    const { result } = renderHook(() =>
      useCanvasNames({
        workspaceId: 'ws1',
        canvases,
        isLocalMode: true,
        daemonFetch,
      }),
    )
    expect(daemonFetch).not.toHaveBeenCalled()
    expect(result.current.effectiveNames).toEqual({ canvases: { foo: 'Foo Local' }, pinned: [] })
  })

  it('renameCanvas PUTs /name and replaces names from the parsed response', async () => {
    const daemonFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ canvases: {}, pinned: [] }))
      .mockResolvedValueOnce(jsonResponse({ canvases: { foo: 'Renamed' }, pinned: [] }))
    const { result } = renderHook(() =>
      useCanvasNames({
        workspaceId: 'ws1',
        canvases: [],
        isLocalMode: false,
        daemonFetch,
      }),
    )
    await waitFor(() => expect(daemonFetch).toHaveBeenCalledTimes(1))
    await act(async () => {
      await result.current.renameCanvas('foo', 'Renamed')
    })
    expect(result.current.effectiveNames.canvases.foo).toBe('Renamed')
  })

  it('togglePin PUTs /pin and replaces names from the parsed response', async () => {
    const daemonFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ canvases: {}, pinned: [] }))
      .mockResolvedValueOnce(jsonResponse({ canvases: {}, pinned: ['foo'] }))
    const { result } = renderHook(() =>
      useCanvasNames({
        workspaceId: 'ws1',
        canvases: [],
        isLocalMode: false,
        daemonFetch,
      }),
    )
    await waitFor(() => expect(daemonFetch).toHaveBeenCalledTimes(1))
    await act(async () => {
      await result.current.togglePin('foo', true)
    })
    expect(result.current.effectiveNames.pinned).toEqual(['foo'])
  })
})
