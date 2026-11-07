import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { jsonResponse } from '../test-utils/json-response.js'
import { expectLoggedFailure } from '../test-utils/logged-failures.js'
import { useMoveByPath, usePlaceByName } from './use-place-by-name.js'

const BASE = 'http://127.0.0.1:3099'
const ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

function controllerOver(path: string, documents: Array<{ documentId: string; path: string }>) {
  return {
    workspaceId: 'w1',
    path,
    documents: documents as never,
    followMove: vi.fn(),
    refreshDocuments: vi.fn(),
  }
}

function recordingFetch() {
  return vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
    jsonResponse({ path: JSON.parse(String(init?.body)).path }),
  ) as unknown as typeof fetch & ReturnType<typeof vi.fn>
}

describe('useMoveByPath', () => {
  it('moves the listed document by its id, then follows it', async () => {
    const controller = controllerOver('boards/mood', [{ documentId: ID, path: 'boards/mood' }])
    const fetchFn = recordingFetch()
    const onPathMoved = vi.fn()
    const { result } = renderHook(() => useMoveByPath(controller, fetchFn, BASE, onPathMoved))

    await act(async () => {
      await result.current('boards/mood-2')
    })

    expect(fetchFn).toHaveBeenCalledTimes(1)
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${BASE}/api/workspaces/w1/documents/${ID}/path`)
    expect(init.method).toBe('PUT')
    expect(JSON.parse(String(init.body))).toEqual({ path: 'boards/mood-2' })
    expect(controller.followMove).toHaveBeenCalledWith('boards/mood-2')
    expect(controller.refreshDocuments).toHaveBeenCalled()
    expect(onPathMoved).toHaveBeenCalledWith('boards/mood-2')
  })

  it('does nothing for a move to where the document already is', async () => {
    const controller = controllerOver('boards/mood', [{ documentId: ID, path: 'boards/mood' }])
    const fetchFn = recordingFetch()
    const { result } = renderHook(() => useMoveByPath(controller, fetchFn, BASE, undefined))
    await act(async () => {
      await result.current('boards/mood')
    })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('rejects, sending nothing, when the listing does not hold the open path', async () => {
    const controller = controllerOver('boards/mood', [])
    const fetchFn = recordingFetch()
    const { result } = renderHook(() => useMoveByPath(controller, fetchFn, BASE, undefined))
    await expect(result.current('elsewhere')).rejects.toThrow('No document is open to move.')
    expect(fetchFn).not.toHaveBeenCalled()
    expect(controller.followMove).not.toHaveBeenCalled()
  })
})

describe('usePlaceByName', () => {
  it('places the listed document by its id at the name’s path', async () => {
    const controller = controllerOver('untitled', [{ documentId: ID, path: 'untitled' }])
    const fetchFn = recordingFetch()
    const onPathMoved = vi.fn()
    const { result } = renderHook(() => usePlaceByName(controller, fetchFn, BASE, onPathMoved))

    act(() => result.current('Checkout'))

    await waitFor(() => expect(onPathMoved).toHaveBeenCalledWith('checkout'))
    expect((fetchFn.mock.calls[0] as [string])[0]).toBe(
      `${BASE}/api/workspaces/w1/documents/${ID}/path`,
    )
  })

  it('sends nothing when the listing does not hold the open path', async () => {
    const controller = controllerOver('untitled', [])
    const fetchFn = recordingFetch()
    const { result } = renderHook(() => usePlaceByName(controller, fetchFn, BASE, undefined))
    act(() => result.current('Checkout'))
    expect(fetchFn).not.toHaveBeenCalled()
    expect(controller.followMove).not.toHaveBeenCalled()
    await expectLoggedFailure('placing a document by its name found no listed document')
  })
})
