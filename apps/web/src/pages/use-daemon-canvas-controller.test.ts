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

  it('respects an explicit workspaceId/slug without calling listWorkspaces', async () => {
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
    expect(mockListWorkspaces).not.toHaveBeenCalled()
    expect(result.current.workspaceId).toBe('w-explicit')
    expect(result.current.slug).toBe('explicit')
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
