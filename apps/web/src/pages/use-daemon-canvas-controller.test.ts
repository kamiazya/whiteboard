import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as daemonApiClient from '../lib/daemon-api-client.js'
import { useDaemonCanvasController } from './use-daemon-canvas-controller.js'

vi.mock('../lib/daemon-api-client.js', () => ({
  listWorkspaces: vi.fn(),
  listCanvases: vi.fn(),
  createCanvas: vi.fn(),
}))

const mockListWorkspaces = vi.mocked(daemonApiClient.listWorkspaces)
const mockListCanvases = vi.mocked(daemonApiClient.listCanvases)
const mockCreateCanvas = vi.mocked(daemonApiClient.createCanvas)

const DAEMON_BASE_URL = 'http://127.0.0.1:3099'
const fetchFn = vi.fn() as unknown as typeof fetch

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useDaemonCanvasController', () => {
  it('picks the first workspace when no workspaceId is given', async () => {
    mockListWorkspaces.mockResolvedValue({
      workspaces: [{ workspaceId: 'w1' }, { workspaceId: 'w2' }],
    })
    mockListCanvases.mockResolvedValue({ canvases: [{ slug: 'main', updatedAt: '2026-01-01' }] })

    const { result } = renderHook(() =>
      useDaemonCanvasController({ daemonBaseUrl: DAEMON_BASE_URL, daemonFetch: fetchFn }),
    )

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.workspaceId).toBe('w1')
    expect(mockListCanvases).toHaveBeenCalledWith(fetchFn, DAEMON_BASE_URL, 'w1')
  })

  it('picks the first canvas when no slug is given', async () => {
    mockListWorkspaces.mockResolvedValue({ workspaces: [{ workspaceId: 'w1' }] })
    mockListCanvases.mockResolvedValue({
      canvases: [
        { slug: 'first', updatedAt: '2026-01-01' },
        { slug: 'second', updatedAt: '2026-01-02' },
      ],
    })

    const { result } = renderHook(() =>
      useDaemonCanvasController({ daemonBaseUrl: DAEMON_BASE_URL, daemonFetch: fetchFn }),
    )

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.slug).toBe('first')
    expect(result.current.canvases).toHaveLength(2)
  })

  it('exposes an empty-state when the workspace has zero canvases', async () => {
    mockListWorkspaces.mockResolvedValue({ workspaces: [{ workspaceId: 'w1' }] })
    mockListCanvases.mockResolvedValue({ canvases: [] })

    const { result } = renderHook(() =>
      useDaemonCanvasController({ daemonBaseUrl: DAEMON_BASE_URL, daemonFetch: fetchFn }),
    )

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.slug).toBeNull()
    expect(result.current.canvases).toEqual([])
  })

  it('still fetches the workspace list when an explicit workspaceId/slug is given, populating controller.workspaces', async () => {
    // The real pairing-payload caller always supplies a non-null workspaceId,
    // so listWorkspaces must run unconditionally for the switcher to have
    // anything to list — it must not be gated behind the wid===null branch.
    mockListWorkspaces.mockResolvedValue({
      workspaces: [{ workspaceId: 'w-explicit' }, { workspaceId: 'w-other' }],
    })
    mockListCanvases.mockResolvedValue({
      canvases: [{ slug: 'explicit', updatedAt: '2026-01-01' }],
    })

    const { result } = renderHook(() =>
      useDaemonCanvasController({
        daemonBaseUrl: DAEMON_BASE_URL,
        workspaceId: 'w-explicit',
        slug: 'explicit',
        daemonFetch: fetchFn,
      }),
    )

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(mockListWorkspaces).toHaveBeenCalledTimes(1)
    expect(result.current.workspaceId).toBe('w-explicit')
    expect(result.current.slug).toBe('explicit')
    expect(result.current.workspaces).toEqual([
      { workspaceId: 'w-explicit' },
      { workspaceId: 'w-other' },
    ])
  })

  it('populates controller.workspaces via a single listWorkspaces call when no workspaceId is given', async () => {
    mockListWorkspaces.mockResolvedValue({
      workspaces: [{ workspaceId: 'w1' }, { workspaceId: 'w2' }],
    })
    mockListCanvases.mockResolvedValue({ canvases: [{ slug: 'main', updatedAt: '2026-01-01' }] })

    const { result } = renderHook(() =>
      useDaemonCanvasController({ daemonBaseUrl: DAEMON_BASE_URL, daemonFetch: fetchFn }),
    )

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(mockListWorkspaces).toHaveBeenCalledTimes(1)
    expect(result.current.workspaces).toEqual([{ workspaceId: 'w1' }, { workspaceId: 'w2' }])
  })

  it('switchWorkspace re-fetches canvases for the new workspace and selects the first canvas', async () => {
    mockListWorkspaces.mockResolvedValue({
      workspaces: [{ workspaceId: 'w1' }, { workspaceId: 'w2' }],
    })
    mockListCanvases.mockResolvedValueOnce({
      canvases: [{ slug: 'w1-canvas', updatedAt: '2026-01-01' }],
    })

    const { result } = renderHook(() =>
      useDaemonCanvasController({ daemonBaseUrl: DAEMON_BASE_URL, daemonFetch: fetchFn }),
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.workspaceId).toBe('w1')
    expect(result.current.slug).toBe('w1-canvas')

    mockListCanvases.mockResolvedValueOnce({
      canvases: [{ slug: 'w2-canvas', updatedAt: '2026-01-02' }],
    })

    await act(async () => {
      await result.current.switchWorkspace('w2')
    })

    expect(mockListCanvases).toHaveBeenLastCalledWith(fetchFn, DAEMON_BASE_URL, 'w2')
    expect(result.current.workspaceId).toBe('w2')
    expect(result.current.slug).toBe('w2-canvas')
    expect(result.current.canvases).toEqual([{ slug: 'w2-canvas', updatedAt: '2026-01-02' }])
  })

  it('switchWorkspace resolves to a null slug (empty state) when the target workspace has zero canvases', async () => {
    mockListWorkspaces.mockResolvedValue({
      workspaces: [{ workspaceId: 'w1' }, { workspaceId: 'w2' }],
    })
    mockListCanvases.mockResolvedValueOnce({
      canvases: [{ slug: 'w1-canvas', updatedAt: '2026-01-01' }],
    })

    const { result } = renderHook(() =>
      useDaemonCanvasController({ daemonBaseUrl: DAEMON_BASE_URL, daemonFetch: fetchFn }),
    )
    await waitFor(() => expect(result.current.loading).toBe(false))

    mockListCanvases.mockResolvedValueOnce({ canvases: [] })

    await act(async () => {
      await result.current.switchWorkspace('w2')
    })

    expect(result.current.slug).toBeNull()
    expect(result.current.canvases).toEqual([])
  })

  it('discards a stale switchWorkspace response when a later switch resolves first (race guard)', async () => {
    mockListWorkspaces.mockResolvedValue({
      workspaces: [{ workspaceId: 'w1' }, { workspaceId: 'w2' }, { workspaceId: 'w3' }],
    })
    mockListCanvases.mockResolvedValueOnce({
      canvases: [{ slug: 'w1-canvas', updatedAt: '2026-01-01' }],
    })

    const { result } = renderHook(() =>
      useDaemonCanvasController({ daemonBaseUrl: DAEMON_BASE_URL, daemonFetch: fetchFn }),
    )
    await waitFor(() => expect(result.current.loading).toBe(false))

    let resolveW2: (value: { canvases: { slug: string; updatedAt: string }[] }) => void = () => {}
    const w2Promise = new Promise<{ canvases: { slug: string; updatedAt: string }[] }>(
      (resolve) => {
        resolveW2 = resolve
      },
    )
    mockListCanvases.mockReturnValueOnce(w2Promise)
    mockListCanvases.mockResolvedValueOnce({
      canvases: [{ slug: 'w3-canvas', updatedAt: '2026-01-03' }],
    })

    let switchW2Done: Promise<void> = Promise.resolve()
    await act(async () => {
      switchW2Done = result.current.switchWorkspace('w2')
      await result.current.switchWorkspace('w3')
    })

    expect(result.current.workspaceId).toBe('w3')
    expect(result.current.slug).toBe('w3-canvas')

    // The stale w2 response resolves after w3 already won; it must be discarded.
    await act(async () => {
      resolveW2({ canvases: [{ slug: 'w2-canvas', updatedAt: '2026-01-02' }] })
      await switchW2Done
    })

    expect(result.current.workspaceId).toBe('w3')
    expect(result.current.slug).toBe('w3-canvas')
  })

  it('switchCanvas updates the selected slug synchronously', async () => {
    mockListWorkspaces.mockResolvedValue({ workspaces: [{ workspaceId: 'w1' }] })
    mockListCanvases.mockResolvedValue({
      canvases: [
        { slug: 'a', updatedAt: '2026-01-01' },
        { slug: 'b', updatedAt: '2026-01-02' },
      ],
    })

    const { result } = renderHook(() =>
      useDaemonCanvasController({ daemonBaseUrl: DAEMON_BASE_URL, daemonFetch: fetchFn }),
    )
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => {
      result.current.switchCanvas('b')
    })
    expect(result.current.slug).toBe('b')
  })

  it('createCanvas creates via the daemon and switches to the new canvas', async () => {
    mockListWorkspaces.mockResolvedValue({ workspaces: [{ workspaceId: 'w1' }] })
    mockListCanvases.mockResolvedValueOnce({ canvases: [] })
    mockCreateCanvas.mockResolvedValue({ slug: 'brand-new' })
    mockListCanvases.mockResolvedValueOnce({
      canvases: [{ slug: 'brand-new', updatedAt: '2026-01-03' }],
    })

    const { result } = renderHook(() =>
      useDaemonCanvasController({ daemonBaseUrl: DAEMON_BASE_URL, daemonFetch: fetchFn }),
    )
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.createCanvas('brand-new')
    })

    expect(mockCreateCanvas).toHaveBeenCalledWith(fetchFn, DAEMON_BASE_URL, 'w1', 'brand-new')
    expect(result.current.slug).toBe('brand-new')
  })

  it('createCanvas surfaces a create error instead of throwing when the daemon call fails', async () => {
    mockListWorkspaces.mockResolvedValue({ workspaces: [{ workspaceId: 'w1' }] })
    mockListCanvases.mockResolvedValue({ canvases: [] })
    mockCreateCanvas.mockRejectedValue(new Error('slug already exists'))

    const { result } = renderHook(() =>
      useDaemonCanvasController({ daemonBaseUrl: DAEMON_BASE_URL, daemonFetch: fetchFn }),
    )
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.createCanvas('brand-new')
    })

    expect(result.current.createError).toBe('slug already exists')
    expect(result.current.slug).toBeNull()
  })

  it('createCanvas is a no-op before workspaceId has resolved', async () => {
    // Never resolves during this test, so workspaceId stays null past mount.
    mockListWorkspaces.mockReturnValue(new Promise(() => {}))

    const { result } = renderHook(() =>
      useDaemonCanvasController({ daemonBaseUrl: DAEMON_BASE_URL, daemonFetch: fetchFn }),
    )
    expect(result.current.workspaceId).toBeNull()

    await act(async () => {
      await result.current.createCanvas('brand-new')
    })

    expect(mockCreateCanvas).not.toHaveBeenCalled()
    expect(result.current.createError).toBeNull()
  })

  it('surfaces a load error instead of throwing when the daemon call fails', async () => {
    mockListWorkspaces.mockRejectedValue(new Error('network down'))

    const { result } = renderHook(() =>
      useDaemonCanvasController({ daemonBaseUrl: DAEMON_BASE_URL, daemonFetch: fetchFn }),
    )

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.loadError).toBe('network down')
  })
})
