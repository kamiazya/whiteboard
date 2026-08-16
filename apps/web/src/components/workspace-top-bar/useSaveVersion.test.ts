import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useSaveVersion } from './useSaveVersion'

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response
}

const VALID_VERSION = {
  version: {
    id: 'v1',
    path: 'foo',
    createdAt: '2026-01-01T00:00:00Z',
    elementCount: 3,
    auto: false,
    hasThumbnail: false,
    branchName: 'main',
  },
}

describe('useSaveVersion', () => {
  it('POSTs /versions and returns true on a schema-valid response', async () => {
    const daemonFetch = vi.fn().mockResolvedValue(jsonResponse(VALID_VERSION))
    const { result } = renderHook(() =>
      useSaveVersion({ workspaceId: 'ws1', path: 'foo', daemonFetch, getThumbnailBlob: undefined }),
    )
    let ok = false
    await act(async () => {
      ok = await result.current.saveVersion('')
    })
    expect(ok).toBe(true)
    expect(daemonFetch).toHaveBeenCalledWith(
      expect.stringContaining('/versions'),
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('returns false without throwing when the response fails schema validation', async () => {
    const daemonFetch = vi.fn().mockResolvedValue(jsonResponse({ nope: true }))
    const { result } = renderHook(() =>
      useSaveVersion({ workspaceId: 'ws1', path: 'foo', daemonFetch, getThumbnailBlob: undefined }),
    )
    let ok = true
    await act(async () => {
      ok = await result.current.saveVersion('')
    })
    expect(ok).toBe(false)
  })

  it('ignores a concurrent second call while a save is already in flight', async () => {
    let resolveFetch: (v: Response) => void = () => {}
    const daemonFetch = vi.fn().mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve
      }),
    )
    const { result } = renderHook(() =>
      useSaveVersion({ workspaceId: 'ws1', path: 'foo', daemonFetch, getThumbnailBlob: undefined }),
    )
    let firstResult: boolean | undefined
    let secondResult: boolean | undefined
    await act(async () => {
      const first = result.current.saveVersion('').then((v) => {
        firstResult = v
      })
      secondResult = await result.current.saveVersion('')
      resolveFetch(jsonResponse(VALID_VERSION))
      await first
    })
    expect(secondResult).toBe(false)
    expect(firstResult).toBe(true)
    expect(daemonFetch).toHaveBeenCalledTimes(1)
  })
})
