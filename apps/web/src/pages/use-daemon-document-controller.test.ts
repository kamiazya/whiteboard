import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as daemonApiClient from '../lib/daemon-api-client.js'
import { useDaemonDocumentController } from './use-daemon-document-controller.js'

vi.mock('../lib/daemon-api-client.js', () => ({
  listWorkspaces: vi.fn(),
  listDocuments: vi.fn(),
  createDocument: vi.fn(),
}))

const mockListWorkspaces = vi.mocked(daemonApiClient.listWorkspaces)
const mockListDocuments = vi.mocked(daemonApiClient.listDocuments)
const mockCreateDocument = vi.mocked(daemonApiClient.createDocument)

const DAEMON_BASE_URL = 'http://127.0.0.1:3099'
const fetchFn = vi.fn() as unknown as typeof fetch

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useDaemonDocumentController', () => {
  it('picks the first workspace when no workspaceId is given', async () => {
    mockListWorkspaces.mockResolvedValue({
      workspaces: [{ workspaceId: 'w1' }, { workspaceId: 'w2' }],
    })
    mockListDocuments.mockResolvedValue({
      documents: [{ path: 'main', id: 'id-main', updatedAt: '2026-01-01', kind: 'spatial' }],
    })

    const { result } = renderHook(() =>
      useDaemonDocumentController({ daemonBaseUrl: DAEMON_BASE_URL, daemonFetch: fetchFn }),
    )

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.workspaceId).toBe('w1')
    expect(mockListDocuments).toHaveBeenCalledWith(fetchFn, DAEMON_BASE_URL, 'w1')
  })

  it('picks the first canvas when no path is given', async () => {
    mockListWorkspaces.mockResolvedValue({ workspaces: [{ workspaceId: 'w1' }] })
    mockListDocuments.mockResolvedValue({
      documents: [
        { path: 'first', id: 'id-first', updatedAt: '2026-01-01', kind: 'spatial' },
        { path: 'second', id: 'id-second', updatedAt: '2026-01-02', kind: 'spatial' },
      ],
    })

    const { result } = renderHook(() =>
      useDaemonDocumentController({ daemonBaseUrl: DAEMON_BASE_URL, daemonFetch: fetchFn }),
    )

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.path).toBe('first')
    expect(result.current.documents).toHaveLength(2)
  })

  it('exposes an empty-state when the workspace has zero documents', async () => {
    mockListWorkspaces.mockResolvedValue({ workspaces: [{ workspaceId: 'w1' }] })
    mockListDocuments.mockResolvedValue({ documents: [] })

    const { result } = renderHook(() =>
      useDaemonDocumentController({ daemonBaseUrl: DAEMON_BASE_URL, daemonFetch: fetchFn }),
    )

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.path).toBeNull()
    expect(result.current.documents).toEqual([])
  })

  it('still fetches the workspace list when an explicit workspaceId/path is given, populating controller.workspaces', async () => {
    // The real pairing-payload caller always supplies a non-null workspaceId,
    // so listWorkspaces must run unconditionally for the switcher to have
    // anything to list — it must not be gated behind the wid===null branch.
    mockListWorkspaces.mockResolvedValue({
      workspaces: [{ workspaceId: 'w-explicit' }, { workspaceId: 'w-other' }],
    })
    mockListDocuments.mockResolvedValue({
      documents: [
        { path: 'explicit', id: 'id-explicit', updatedAt: '2026-01-01', kind: 'spatial' },
      ],
    })

    const { result } = renderHook(() =>
      useDaemonDocumentController({
        daemonBaseUrl: DAEMON_BASE_URL,
        workspaceId: 'w-explicit',
        path: 'explicit',
        daemonFetch: fetchFn,
      }),
    )

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(mockListWorkspaces).toHaveBeenCalledTimes(1)
    expect(result.current.workspaceId).toBe('w-explicit')
    expect(result.current.path).toBe('explicit')
    expect(result.current.workspaces).toEqual([
      { workspaceId: 'w-explicit' },
      { workspaceId: 'w-other' },
    ])
  })

  it('populates controller.workspaces via a single listWorkspaces call when no workspaceId is given', async () => {
    mockListWorkspaces.mockResolvedValue({
      workspaces: [{ workspaceId: 'w1' }, { workspaceId: 'w2' }],
    })
    mockListDocuments.mockResolvedValue({
      documents: [{ path: 'main', id: 'id-main', updatedAt: '2026-01-01', kind: 'spatial' }],
    })

    const { result } = renderHook(() =>
      useDaemonDocumentController({ daemonBaseUrl: DAEMON_BASE_URL, daemonFetch: fetchFn }),
    )

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(mockListWorkspaces).toHaveBeenCalledTimes(1)
    expect(result.current.workspaces).toEqual([{ workspaceId: 'w1' }, { workspaceId: 'w2' }])
  })

  it('switchWorkspace re-fetches documents for the new workspace and selects the first canvas', async () => {
    mockListWorkspaces.mockResolvedValue({
      workspaces: [{ workspaceId: 'w1' }, { workspaceId: 'w2' }],
    })
    mockListDocuments.mockResolvedValueOnce({
      documents: [
        { path: 'w1-canvas', id: 'id-w1-canvas', updatedAt: '2026-01-01', kind: 'spatial' },
      ],
    })

    const { result } = renderHook(() =>
      useDaemonDocumentController({ daemonBaseUrl: DAEMON_BASE_URL, daemonFetch: fetchFn }),
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.workspaceId).toBe('w1')
    expect(result.current.path).toBe('w1-canvas')

    mockListDocuments.mockResolvedValueOnce({
      documents: [
        { path: 'w2-canvas', id: 'id-w2-canvas', updatedAt: '2026-01-02', kind: 'spatial' },
      ],
    })

    await act(async () => {
      await result.current.switchWorkspace('w2')
    })

    expect(mockListDocuments).toHaveBeenLastCalledWith(fetchFn, DAEMON_BASE_URL, 'w2')
    expect(result.current.workspaceId).toBe('w2')
    expect(result.current.path).toBe('w2-canvas')
    expect(result.current.documents).toEqual([
      { path: 'w2-canvas', id: 'id-w2-canvas', updatedAt: '2026-01-02', kind: 'spatial' },
    ])
  })

  it('switchWorkspace resolves to a null path (empty state) when the target workspace has zero documents', async () => {
    mockListWorkspaces.mockResolvedValue({
      workspaces: [{ workspaceId: 'w1' }, { workspaceId: 'w2' }],
    })
    mockListDocuments.mockResolvedValueOnce({
      documents: [
        { path: 'w1-canvas', id: 'id-w1-canvas', updatedAt: '2026-01-01', kind: 'spatial' },
      ],
    })

    const { result } = renderHook(() =>
      useDaemonDocumentController({ daemonBaseUrl: DAEMON_BASE_URL, daemonFetch: fetchFn }),
    )
    await waitFor(() => expect(result.current.loading).toBe(false))

    mockListDocuments.mockResolvedValueOnce({ documents: [] })

    await act(async () => {
      await result.current.switchWorkspace('w2')
    })

    expect(result.current.path).toBeNull()
    expect(result.current.documents).toEqual([])
  })

  it('discards a stale switchWorkspace response when a later switch resolves first (race guard)', async () => {
    mockListWorkspaces.mockResolvedValue({
      workspaces: [{ workspaceId: 'w1' }, { workspaceId: 'w2' }, { workspaceId: 'w3' }],
    })
    mockListDocuments.mockResolvedValueOnce({
      documents: [
        { path: 'w1-canvas', id: 'id-w1-canvas', updatedAt: '2026-01-01', kind: 'spatial' },
      ],
    })

    const { result } = renderHook(() =>
      useDaemonDocumentController({ daemonBaseUrl: DAEMON_BASE_URL, daemonFetch: fetchFn }),
    )
    await waitFor(() => expect(result.current.loading).toBe(false))

    let resolveW2: (value: {
      documents: { path: string; id: string; updatedAt: string; kind: 'spatial' | 'markdown' }[]
    }) => void = () => {}
    const w2Promise = new Promise<{
      documents: { path: string; id: string; updatedAt: string; kind: 'spatial' | 'markdown' }[]
    }>((resolve) => {
      resolveW2 = resolve
    })
    mockListDocuments.mockReturnValueOnce(w2Promise)
    mockListDocuments.mockResolvedValueOnce({
      documents: [
        { path: 'w3-canvas', id: 'id-w3-canvas', updatedAt: '2026-01-03', kind: 'spatial' },
      ],
    })

    let switchW2Done: Promise<void> = Promise.resolve()
    await act(async () => {
      switchW2Done = result.current.switchWorkspace('w2')
      await result.current.switchWorkspace('w3')
    })

    expect(result.current.workspaceId).toBe('w3')
    expect(result.current.path).toBe('w3-canvas')

    // The stale w2 response resolves after w3 already won; it must be discarded.
    await act(async () => {
      resolveW2({
        documents: [
          { path: 'w2-canvas', id: 'id-w2-canvas', updatedAt: '2026-01-02', kind: 'spatial' },
        ],
      })
      await switchW2Done
    })

    expect(result.current.workspaceId).toBe('w3')
    expect(result.current.path).toBe('w3-canvas')
  })

  it('switchDocument updates the selected path synchronously', async () => {
    mockListWorkspaces.mockResolvedValue({ workspaces: [{ workspaceId: 'w1' }] })
    mockListDocuments.mockResolvedValue({
      documents: [
        { path: 'a', id: 'id-a', updatedAt: '2026-01-01', kind: 'spatial' },
        { path: 'b', id: 'id-b', updatedAt: '2026-01-02', kind: 'spatial' },
      ],
    })

    const { result } = renderHook(() =>
      useDaemonDocumentController({ daemonBaseUrl: DAEMON_BASE_URL, daemonFetch: fetchFn }),
    )
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => {
      result.current.switchDocument('b')
    })
    expect(result.current.path).toBe('b')
  })

  it('createDocument creates via the daemon and switches to the new canvas', async () => {
    mockListWorkspaces.mockResolvedValue({ workspaces: [{ workspaceId: 'w1' }] })
    mockListDocuments.mockResolvedValueOnce({ documents: [] })
    mockCreateDocument.mockResolvedValue({ path: 'brand-new' })
    mockListDocuments.mockResolvedValueOnce({
      documents: [
        { path: 'brand-new', id: 'id-brand-new', updatedAt: '2026-01-03', kind: 'spatial' },
      ],
    })

    const { result } = renderHook(() =>
      useDaemonDocumentController({ daemonBaseUrl: DAEMON_BASE_URL, daemonFetch: fetchFn }),
    )
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.createDocument('brand-new')
    })

    expect(mockCreateDocument).toHaveBeenCalledWith(fetchFn, DAEMON_BASE_URL, 'w1', 'brand-new')
    expect(result.current.path).toBe('brand-new')
  })

  it('createDocument surfaces a create error instead of throwing when the daemon call fails', async () => {
    mockListWorkspaces.mockResolvedValue({ workspaces: [{ workspaceId: 'w1' }] })
    mockListDocuments.mockResolvedValue({ documents: [] })
    mockCreateDocument.mockRejectedValue(new Error('path already exists'))

    const { result } = renderHook(() =>
      useDaemonDocumentController({ daemonBaseUrl: DAEMON_BASE_URL, daemonFetch: fetchFn }),
    )
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.createDocument('brand-new')
    })

    expect(result.current.createError).toBe('path already exists')
    expect(result.current.path).toBeNull()
  })

  // The empty-state caller derives its next path from `documents`. If a create fails because
  // another client already took that path, `documents` is stale by definition — without a
  // refresh here, a retry re-derives the SAME losing path from the same stale list forever.
  it('createDocument re-reads the canvas list after a failure so a retry does not repeat the same path', async () => {
    mockListWorkspaces.mockResolvedValue({ workspaces: [{ workspaceId: 'w1' }] })
    mockListDocuments.mockResolvedValueOnce({ documents: [] })
    mockCreateDocument.mockRejectedValue(new Error('path already exists'))

    const { result } = renderHook(() =>
      useDaemonDocumentController({ daemonBaseUrl: DAEMON_BASE_URL, daemonFetch: fetchFn }),
    )
    await waitFor(() => expect(result.current.loading).toBe(false))

    mockListDocuments.mockResolvedValueOnce({
      documents: [
        { path: 'untitled', id: 'id-untitled', updatedAt: '2026-01-01', kind: 'spatial' },
      ],
    })

    await act(async () => {
      await result.current.createDocument('untitled')
    })

    expect(result.current.createError).toBe('path already exists')
    // The refreshed list now shows the path another client already took.
    expect(result.current.documents).toEqual([
      { path: 'untitled', id: 'id-untitled', updatedAt: '2026-01-01', kind: 'spatial' },
    ])
  })

  it('createDocument is a no-op before workspaceId has resolved', async () => {
    // Never resolves during this test, so workspaceId stays null past mount.
    mockListWorkspaces.mockReturnValue(new Promise(() => {}))

    const { result } = renderHook(() =>
      useDaemonDocumentController({ daemonBaseUrl: DAEMON_BASE_URL, daemonFetch: fetchFn }),
    )
    expect(result.current.workspaceId).toBeNull()

    await act(async () => {
      await result.current.createDocument('brand-new')
    })

    expect(mockCreateDocument).not.toHaveBeenCalled()
    expect(result.current.createError).toBeNull()
  })

  it('surfaces a load error instead of throwing when the daemon call fails', async () => {
    mockListWorkspaces.mockRejectedValue(new Error('network down'))

    const { result } = renderHook(() =>
      useDaemonDocumentController({ daemonBaseUrl: DAEMON_BASE_URL, daemonFetch: fetchFn }),
    )

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.loadError).toBe('network down')
  })

  it('switchWorkspace surfaces a switchError (not loadError) and keeps the previous workspace/canvas selected on failure', async () => {
    mockListWorkspaces.mockResolvedValue({
      workspaces: [{ workspaceId: 'w1' }, { workspaceId: 'w2' }],
    })
    mockListDocuments.mockResolvedValueOnce({
      documents: [
        { path: 'w1-canvas', id: 'id-w1-canvas', updatedAt: '2026-01-01', kind: 'spatial' },
      ],
    })

    const { result } = renderHook(() =>
      useDaemonDocumentController({ daemonBaseUrl: DAEMON_BASE_URL, daemonFetch: fetchFn }),
    )
    await waitFor(() => expect(result.current.loading).toBe(false))

    mockListDocuments.mockRejectedValueOnce(new Error('daemon unreachable'))

    await act(async () => {
      await result.current.switchWorkspace('w2')
    })

    expect(result.current.switchError).toBe('daemon unreachable')
    expect(result.current.loadError).toBeNull()
    expect(result.current.workspaceId).toBe('w1')
    expect(result.current.path).toBe('w1-canvas')
    expect(result.current.documents).toEqual([
      { path: 'w1-canvas', id: 'id-w1-canvas', updatedAt: '2026-01-01', kind: 'spatial' },
    ])
  })
})
