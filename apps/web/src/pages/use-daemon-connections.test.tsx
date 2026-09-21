import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useDaemonConnections } from './use-daemon-connections.js'

// The response is parsed through `backlinkEntrySchema`, which is `.strict()`
// and wants a canonical ULID plus the excerpt list — a loose fixture is
// rejected, the hook's catch swallows it, and the case then measures nothing
// but a timeout.
const BACKLINK = {
  documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  path: 'a',
  name: 'A',
  contexts: ['mentions it here'],
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('useDaemonConnections', () => {
  it('clears the departed document’s backlinks on a switch, before the list has named the new id', async () => {
    // The fetch effect nulls the value itself, but it is keyed on the
    // document ID — and after a switch the id LAGS, because it comes from a
    // list that may still be refreshing. So for as long as the lag lasts the
    // effect does not re-run, and without the reset keyed on the PATH the
    // arrived document shows the departed one's backlinks.
    const fetchFn = vi.fn(async () =>
      jsonResponse({ backlinks: [BACKLINK], unlinkedMentions: [] }),
    ) as unknown as typeof globalThis.fetch

    const { result, rerender } = renderHook(
      (props: { path: string; documentId: string | undefined }) =>
        useDaemonConnections({
          daemonFetch: fetchFn,
          daemonBaseUrl: 'http://d',
          workspaceId: 'ws-a',
          documentId: props.documentId,
          path: props.path,
        }),
      { initialProps: { path: 'a', documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' } },
    )

    await waitFor(() => {
      expect(result.current.connections?.backlinks).toHaveLength(1)
    })

    // The switch lands; the list has NOT caught up, so the id is unchanged.
    rerender({ path: 'b', documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' })

    expect(result.current.connections).toBeNull()
  })

  it('a response in flight when the path changes does not refill the panel it just cleared', async () => {
    // The SCOPE RESET clears on the path, and the fetch effect is keyed on the
    // document ID — so a switch while the id still LAGS runs no cleanup, leaves
    // `cancelled` false, and the in-flight response lands AFTER the reset. The
    // departed document's backlinks are then shown under the arrived one, which
    // is the exact state the reset exists to prevent, arriving one step later.
    let releaseFirst: ((response: Response) => void) | undefined
    const fetchFn = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          releaseFirst = resolve
        }),
    ) as unknown as typeof globalThis.fetch

    const { result, rerender } = renderHook(
      (props: { path: string }) =>
        useDaemonConnections({
          daemonFetch: fetchFn,
          daemonBaseUrl: 'http://d',
          workspaceId: 'ws-a',
          documentId: BACKLINK.documentId,
          path: props.path,
        }),
      { initialProps: { path: 'a' } },
    )

    // The switch lands while the request is still open and the id still lags.
    rerender({ path: 'b' })
    expect(result.current.connections).toBeNull()

    await act(async () => {
      releaseFirst?.(jsonResponse({ backlinks: [BACKLINK], unlinkedMentions: [] }))
    })

    expect(result.current.connections).toBeNull()
  })

  it('blanks the panel while a NEW document id is loading, rather than showing the old one’s', async () => {
    // The other direction of the same hazard: the list catches up and names a
    // different id for what is on screen. The path may not have changed (a
    // document deleted and recreated at the same path), so the SCOPE RESET
    // does not fire and the fetch effect's own null is what stops the panel
    // showing the previous document's backlinks while the new ones load.
    const OTHER = '01ARZ3NDEKTSV4RRFFQ69G5FB0'
    let releaseSecond: ((response: Response) => void) | undefined
    const fetchFn = vi.fn((input: RequestInfo | URL) =>
      String(input).includes(OTHER)
        ? new Promise<Response>((resolve) => {
            releaseSecond = resolve
          })
        : Promise.resolve(jsonResponse({ backlinks: [BACKLINK], unlinkedMentions: [] })),
    ) as unknown as typeof globalThis.fetch

    const { result, rerender } = renderHook(
      (props: { documentId: string }) =>
        useDaemonConnections({
          daemonFetch: fetchFn,
          daemonBaseUrl: 'http://d',
          workspaceId: 'ws-a',
          documentId: props.documentId,
          path: 'a',
        }),
      { initialProps: { documentId: BACKLINK.documentId } },
    )

    await waitFor(() => expect(result.current.connections?.backlinks).toHaveLength(1))

    // Same path, different id: the second fetch is held, so what the panel
    // shows right now is the whole question.
    rerender({ documentId: OTHER })
    expect(result.current.connections).toBeNull()

    await act(async () => {
      releaseSecond?.(jsonResponse({ backlinks: [], unlinkedMentions: [BACKLINK] }))
    })
    expect(result.current.connections?.unlinkedMentions).toHaveLength(1)
  })

  it('refetches when refresh is called, and keeps the same document', async () => {
    // What `refresh` is for: the panel linkifies a mention and wants the
    // backlinks again for the document already on screen.
    let calls = 0
    const fetchFn = vi.fn(async () => {
      calls += 1
      return jsonResponse({
        backlinks: Array.from({ length: calls }, () => BACKLINK),
        unlinkedMentions: [],
      })
    }) as unknown as typeof globalThis.fetch

    const { result } = renderHook(() =>
      useDaemonConnections({
        daemonFetch: fetchFn,
        daemonBaseUrl: 'http://d',
        workspaceId: 'ws-a',
        documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        path: 'a',
      }),
    )

    await waitFor(() => expect(result.current.connections?.backlinks).toHaveLength(1))

    act(() => {
      result.current.refresh()
    })

    await waitFor(() => expect(result.current.connections?.backlinks).toHaveLength(2))
  })

  it('a fetch overtaken by a switch never lands on the document that replaced it', async () => {
    // The `cancelled` flag. Without it the departed document's backlinks
    // arrive late and overwrite the arrived one's — the same defect the
    // SCOPE RESET prevents, arriving from the other side and surviving it,
    // because the write happens AFTER the reset has run.
    const OTHER = '01ARZ3NDEKTSV4RRFFQ69G5FB0'
    let releaseFirst: ((response: Response) => void) | undefined
    const fetchFn = vi.fn((input: RequestInfo | URL) =>
      String(input).includes(OTHER)
        ? Promise.resolve(jsonResponse({ backlinks: [], unlinkedMentions: [BACKLINK] }))
        : new Promise<Response>((resolve) => {
            releaseFirst = resolve
          }),
    ) as unknown as typeof globalThis.fetch

    const { result, rerender } = renderHook(
      (props: { documentId: string }) =>
        useDaemonConnections({
          daemonFetch: fetchFn,
          daemonBaseUrl: 'http://d',
          workspaceId: 'ws-a',
          documentId: props.documentId,
          path: 'a',
        }),
      { initialProps: { documentId: BACKLINK.documentId } },
    )

    rerender({ documentId: OTHER })
    await waitFor(() => expect(result.current.connections?.unlinkedMentions).toHaveLength(1))

    // The overtaken fetch answers last, with the DEPARTED document's data.
    await act(async () => {
      releaseFirst?.(jsonResponse({ backlinks: [BACKLINK], unlinkedMentions: [] }))
    })

    expect(result.current.connections?.unlinkedMentions).toHaveLength(1)
    expect(result.current.connections?.backlinks).toHaveLength(0)
  })

  it('asks for nothing while the list has named no id, and leaves the chip empty', async () => {
    // The list holds no row for this path yet (a refresh in flight, or a
    // document just created). Querying with a path is a request the route
    // would reject, so the hook does not make one.
    const fetchFn = vi.fn() as unknown as typeof globalThis.fetch

    const { result } = renderHook(() =>
      useDaemonConnections({
        daemonFetch: fetchFn,
        daemonBaseUrl: 'http://d',
        workspaceId: 'ws-a',
        documentId: undefined,
        path: 'a',
      }),
    )

    expect(result.current.connections).toBeNull()
    expect(fetchFn).not.toHaveBeenCalled()
  })
})
