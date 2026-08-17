import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { DocumentInfo } from './types'
import { useDocumentNames } from './useDocumentNames'

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    json: async () => body,
  } as Response
}

describe('useDocumentNames', () => {
  it('parses a well-formed /names response into effectiveNames', async () => {
    const daemonFetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ documents: { foo: 'Foo Canvas' }, pinned: ['foo'] }))
    const { result } = renderHook(() =>
      useDocumentNames({
        workspaceId: 'ws1',
        documents: [],
        isLocalMode: false,
        daemonFetch,
      }),
    )
    await waitFor(() => {
      expect(result.current.effectiveNames.documents.foo).toBe('Foo Canvas')
    })
    expect(result.current.effectiveNames.pinned).toEqual(['foo'])
  })

  it('falls back to empty names when the /names response fails schema validation', async () => {
    const daemonFetch = vi.fn().mockResolvedValue(jsonResponse({ documents: 'not-an-object' }))
    const { result } = renderHook(() =>
      useDocumentNames({
        workspaceId: 'ws1',
        documents: [],
        isLocalMode: false,
        daemonFetch,
      }),
    )
    // The malformed payload throws inside workspaceNamesSchema.parse, caught by
    // the hook's best-effort try/catch — state stays at the initial empty value.
    await waitFor(() => {
      expect(daemonFetch).toHaveBeenCalled()
    })
    expect(result.current.effectiveNames).toEqual({ documents: {}, pinned: [] })
  })

  it('derives local-mode names from the documents array instead of fetching', () => {
    const daemonFetch = vi.fn()
    const documents: DocumentInfo[] = [{ path: 'foo', updatedAt: '2026-01-01', name: 'Foo Local' }]
    const { result } = renderHook(() =>
      useDocumentNames({
        workspaceId: 'ws1',
        documents,
        isLocalMode: true,
        daemonFetch,
      }),
    )
    expect(daemonFetch).not.toHaveBeenCalled()
    expect(result.current.effectiveNames).toEqual({ documents: { foo: 'Foo Local' }, pinned: [] })
  })

  it('renameDocument PUTs /name and replaces names from the parsed response', async () => {
    const daemonFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ documents: {}, pinned: [] }))
      .mockResolvedValueOnce(jsonResponse({ documents: { foo: 'Renamed' }, pinned: [] }))
    const { result } = renderHook(() =>
      useDocumentNames({
        workspaceId: 'ws1',
        documents: [],
        isLocalMode: false,
        daemonFetch,
      }),
    )
    await waitFor(() => expect(daemonFetch).toHaveBeenCalledTimes(1))
    await act(async () => {
      await result.current.renameDocument('foo', 'Renamed')
    })
    expect(result.current.effectiveNames.documents.foo).toBe('Renamed')
  })

  it('togglePin PUTs /pin and replaces names from the parsed response', async () => {
    const daemonFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ documents: {}, pinned: [] }))
      .mockResolvedValueOnce(jsonResponse({ documents: {}, pinned: ['foo'] }))
    const { result } = renderHook(() =>
      useDocumentNames({
        workspaceId: 'ws1',
        documents: [],
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
