import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { expectLoggedFailure } from '../../test-utils/logged-failures.js'
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
        keptByBrowser: false,
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
        keptByBrowser: false,
        daemonFetch,
      }),
    )
    // The malformed payload is refused as a contract mismatch, which the
    // hook's best-effort catch swallows — state stays at the initial empty
    // value, and the record is what says which route disagreed.
    await waitFor(() => {
      expect(daemonFetch).toHaveBeenCalled()
    })
    await expectLoggedFailure('/api/workspaces/ws1/names failed its contract at documents')
    expect(result.current.effectiveNames).toEqual({ documents: {}, pinned: [] })
  })

  it('answers empty names for a browser-kept workspace without ever fetching', () => {
    const daemonFetch = vi.fn()
    const { result } = renderHook(() =>
      useDocumentNames({ workspaceId: 'ws', keptByBrowser: true, daemonFetch }),
    )
    expect(result.current.effectiveNames).toEqual({ documents: {}, pinned: [] })
    expect(daemonFetch).not.toHaveBeenCalled()
  })

  it('renameDocument PUTs /name and replaces names from the parsed response', async () => {
    const daemonFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ documents: {}, pinned: [] }))
      .mockResolvedValueOnce(jsonResponse({ documents: { foo: 'Renamed' }, pinned: [] }))
    const { result } = renderHook(() =>
      useDocumentNames({
        workspaceId: 'ws1',
        keptByBrowser: false,
        daemonFetch,
      }),
    )
    await waitFor(() => expect(daemonFetch).toHaveBeenCalledTimes(1))
    await act(async () => {
      await result.current.renameDocument('foo', 'Renamed')
    })
    expect(result.current.effectiveNames.documents.foo).toBe('Renamed')
  })

  it('renameDocument answers null once the daemon has saved the name', async () => {
    const daemonFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ documents: {}, pinned: [] }))
      .mockResolvedValueOnce(jsonResponse({ documents: { foo: 'Renamed' }, pinned: [] }))
    const { result } = renderHook(() =>
      useDocumentNames({ workspaceId: 'ws1', keptByBrowser: false, daemonFetch }),
    )
    await waitFor(() => expect(daemonFetch).toHaveBeenCalledTimes(1))
    let outcome: string | null | undefined
    await act(async () => {
      outcome = await result.current.renameDocument('foo', 'Renamed')
    })
    expect(outcome).toBeNull()
  })

  it("renameDocument answers a refused PUT with the daemon's own reason and keeps the names", async () => {
    const daemonFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ documents: { foo: 'Before' }, pinned: [] }))
      .mockResolvedValueOnce(
        jsonResponse(
          { error: 'invalid_body', message: 'a display name is at most 200 characters' },
          false,
        ),
      )
    const { result } = renderHook(() =>
      useDocumentNames({ workspaceId: 'ws1', keptByBrowser: false, daemonFetch }),
    )
    await waitFor(() => expect(result.current.effectiveNames.documents.foo).toBe('Before'))
    let outcome: string | null | undefined
    await act(async () => {
      outcome = await result.current.renameDocument('foo', 'x'.repeat(201))
    })
    expect(outcome).toBe('a display name is at most 200 characters')
    expect(result.current.effectiveNames.documents.foo).toBe('Before')
  })

  it('renameDocument answers a refusal with no readable reason in its own words', async () => {
    const daemonFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ documents: {}, pinned: [] }))
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        json: async () => {
          throw new SyntaxError('not JSON')
        },
      } as unknown as Response)
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const { result } = renderHook(() =>
      useDocumentNames({ workspaceId: 'ws1', keptByBrowser: false, daemonFetch }),
    )
    await waitFor(() => expect(daemonFetch).toHaveBeenCalledTimes(1))
    const outcomes: Array<string | null> = []
    await act(async () => {
      outcomes.push(await result.current.renameDocument('foo', 'Renamed'))
      outcomes.push(await result.current.renameDocument('foo', 'Renamed'))
    })
    expect(outcomes).toEqual(['Could not rename it.', 'Could not rename it.'])
  })
})
