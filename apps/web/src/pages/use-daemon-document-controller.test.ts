import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as daemonApiClient from '../lib/daemon-api-client.js'
import * as passkeySession from '../lib/passkey-session.js'
import { useDaemonDocumentController } from './use-daemon-document-controller.js'

// Spreads importOriginal so `DaemonApiError` stays the REAL class — the
// membership classifier's `instanceof DaemonApiError` throws on `undefined`
// otherwise, and every rejection case below reads as an unrelated failure.
vi.mock('../lib/daemon-api-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof daemonApiClient>()),
  listWorkspaces: vi.fn(),
  listDocuments: vi.fn(),
  createDocument: vi.fn(),
}))

vi.mock('../lib/passkey-session.js', () => ({
  bindPasskeySession: vi.fn(),
}))

const mockListWorkspaces = vi.mocked(daemonApiClient.listWorkspaces)
const mockListDocuments = vi.mocked(daemonApiClient.listDocuments)
const mockCreateDocument = vi.mocked(daemonApiClient.createDocument)
const mockBindPasskeySession = vi.mocked(passkeySession.bindPasskeySession)

const DAEMON_BASE_URL = 'http://127.0.0.1:3099'
const fetchFn = vi.fn() as unknown as typeof fetch

beforeEach(() => {
  vi.clearAllMocks()
  mockBindPasskeySession.mockResolvedValue({ ok: true })
})

function refusal(code: 'requires_person_session' | 'not_a_member') {
  return new daemonApiClient.DaemonApiError('refused', 403, { error: code, message: 'refused' })
}

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

  // A membership refusal is realistically answered by the workspace-scoped
  // route (listDocuments) — GET /api/workspaces FILTERS a gated workspace
  // out rather than refusing it, so listWorkspaces always resolves.
  it('a requires_person_session refusal binds the passkey once and retries, loading the workspace', async () => {
    mockListWorkspaces.mockResolvedValue({ workspaces: [{ workspaceId: 'w1' }] })
    mockListDocuments
      .mockRejectedValueOnce(refusal('requires_person_session'))
      .mockResolvedValueOnce({
        documents: [{ path: 'main', id: 'id-main', updatedAt: '2026-01-01', kind: 'spatial' }],
      })

    const { result } = renderHook(() =>
      useDaemonDocumentController({ daemonBaseUrl: DAEMON_BASE_URL, daemonFetch: fetchFn }),
    )

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(mockBindPasskeySession).toHaveBeenCalledTimes(1)
    expect(result.current.refusal).toBeNull()
    expect(result.current.loadError).toBeNull()
    expect(result.current.workspaceId).toBe('w1')
  })

  it('a second requires_person_session refusal (bind already spent) surfaces as controller.refusal, not loadError', async () => {
    mockListWorkspaces.mockResolvedValue({ workspaces: [{ workspaceId: 'w1' }] })
    mockListDocuments.mockRejectedValue(refusal('requires_person_session'))

    const { result } = renderHook(() =>
      useDaemonDocumentController({ daemonBaseUrl: DAEMON_BASE_URL, daemonFetch: fetchFn }),
    )

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(mockBindPasskeySession).toHaveBeenCalledTimes(1)
    expect(result.current.refusal).toEqual({ code: 'requires_person_session', workspaceId: 'w1' })
    expect(result.current.loadError).toBeNull()
    expect(result.current.workspaceId).toBeNull()
  })

  it('a not_a_member refusal surfaces as controller.refusal without ever binding', async () => {
    mockListWorkspaces.mockResolvedValue({ workspaces: [{ workspaceId: 'w1' }] })
    mockListDocuments.mockRejectedValue(refusal('not_a_member'))

    const { result } = renderHook(() =>
      useDaemonDocumentController({ daemonBaseUrl: DAEMON_BASE_URL, daemonFetch: fetchFn }),
    )

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(mockBindPasskeySession).not.toHaveBeenCalled()
    expect(result.current.refusal).toEqual({ code: 'not_a_member', workspaceId: 'w1' })
    expect(result.current.workspaceId).toBeNull()
  })

  it('a not_a_member refusal arriving AFTER a successful bind surfaces as controller.refusal', async () => {
    mockListWorkspaces.mockResolvedValue({ workspaces: [{ workspaceId: 'w1' }] })
    mockListDocuments
      .mockRejectedValueOnce(refusal('requires_person_session'))
      .mockRejectedValueOnce(refusal('not_a_member'))

    const { result } = renderHook(() =>
      useDaemonDocumentController({ daemonBaseUrl: DAEMON_BASE_URL, daemonFetch: fetchFn }),
    )

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(mockBindPasskeySession).toHaveBeenCalledTimes(1)
    expect(result.current.refusal).toEqual({ code: 'not_a_member', workspaceId: 'w1' })
    // Admission gate: workspaceId is set only once listDocuments succeeds, so
    // a refused workspace never arms the push/refresh effect that keys on it.
    expect(result.current.workspaceId).toBeNull()
  })

  it('workspaceId stays null while listDocuments is pending, even though listWorkspaces has resolved', async () => {
    mockListWorkspaces.mockResolvedValue({ workspaces: [{ workspaceId: 'w1' }] })
    let resolveDocuments: (v: { documents: never[] }) => void = () => {}
    mockListDocuments.mockReturnValue(
      new Promise((resolve) => {
        resolveDocuments = resolve
      }),
    )

    const { result } = renderHook(() =>
      useDaemonDocumentController({ daemonBaseUrl: DAEMON_BASE_URL, daemonFetch: fetchFn }),
    )

    await waitFor(() => expect(mockListDocuments).toHaveBeenCalled())
    expect(result.current.workspaceId).toBeNull()

    await act(async () => {
      resolveDocuments({ documents: [] })
    })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.workspaceId).toBe('w1')
  })

  it('retry() after a bind-already-spent refusal permits exactly one more bind', async () => {
    mockListWorkspaces.mockResolvedValue({ workspaces: [{ workspaceId: 'w1' }] })
    mockListDocuments
      // attempt 0: first load refuses, bind #1 runs, the retried load refuses again → surfaces
      .mockRejectedValueOnce(refusal('requires_person_session'))
      .mockRejectedValueOnce(refusal('requires_person_session'))
      // attempt 1 (after retry()): first load refuses again, bind #2 runs, the retried load succeeds
      .mockRejectedValueOnce(refusal('requires_person_session'))
      .mockResolvedValueOnce({
        documents: [{ path: 'main', id: 'id-main', updatedAt: '2026-01-01', kind: 'spatial' }],
      })

    const { result } = renderHook(() =>
      useDaemonDocumentController({ daemonBaseUrl: DAEMON_BASE_URL, daemonFetch: fetchFn }),
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.refusal).toEqual({ code: 'requires_person_session', workspaceId: 'w1' })
    expect(mockBindPasskeySession).toHaveBeenCalledTimes(1)

    act(() => {
      result.current.retry()
    })

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(mockBindPasskeySession).toHaveBeenCalledTimes(2)
    expect(result.current.refusal).toBeNull()
    expect(result.current.workspaceId).toBe('w1')
  })
})
