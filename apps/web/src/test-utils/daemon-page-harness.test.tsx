import { act, cleanup, screen } from '@testing-library/react'
import { useLocation } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  daemonApiClientMock,
  fakeSseBackendModule,
  markdownWorkspaceSnapshot,
  navigateTo,
  renderInRouter,
  replicaRefreshMock,
} from './daemon-page-harness.js'

function Where() {
  return <output data-testid="where">{useLocation().pathname}</output>
}

afterEach(cleanup)

describe('daemon page harness', () => {
  it('mounts the page at the route, inside a parent of the height asked for', () => {
    renderInRouter(<Where />, { route: '/w/board', height: '50vh' })
    expect(screen.getByTestId('where').textContent).toBe('/w/board')
    expect((screen.getByTestId('where').parentElement as HTMLElement).style.height).toBe('50vh')
  })

  it('adds no parent when no height is asked for', () => {
    const { container } = renderInRouter(<Where />)
    expect(container.firstElementChild).toBe(screen.getByTestId('where'))
  })

  it('moves the page to another route through a mounted probe', () => {
    renderInRouter(<Where />, { probe: true })
    act(() => navigateTo('/elsewhere'))
    expect(screen.getByTestId('where').textContent).toBe('/elsewhere')
  })

  it('answers the cancel the page calls on unmount from each replica scheduler', () => {
    const { scheduleReplicaRefresh, scheduleReplicaPush } = replicaRefreshMock()
    expect(typeof scheduleReplicaRefresh()).toBe('function')
    expect(typeof scheduleReplicaPush()).toBe('function')
  })

  it('stubs only the functions it is asked to, with the defaults given', async () => {
    const actual = { listWorkspaces: () => 'real', keptReal: () => 'real' }
    const mocked = await daemonApiClientMock(async <T,>() => actual as T, ['listWorkspaces'], {
      listWorkspaces: async () => ({ workspaces: [] }),
    } as never)
    expect(vi.isMockFunction(mocked.listWorkspaces)).toBe(true)
    await expect(mocked.listWorkspaces({} as never, '')).resolves.toEqual({ workspaces: [] })
    expect((mocked as unknown as typeof actual).keptReal()).toBe('real')
  })

  it("builds the SSE backend for a path and delivers that path's snapshot", () => {
    const built: string[] = []
    const { SseBackend } = fakeSseBackendModule({
      onConstruct: (workspaceId, path) => built.push(`${workspaceId}/${path}`),
      snapshotFor: (path) =>
        markdownWorkspaceSnapshot({ path, documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV', body: '# hi' }),
    })
    const handlers = { onConnected: vi.fn(), onSnapshot: vi.fn() }
    new SseBackend('w1', 'note').connect(handlers as never)
    expect(built).toEqual(['w1/note'])
    expect(handlers.onConnected).toHaveBeenCalledOnce()
    expect(handlers.onSnapshot.mock.calls[0]?.[0]).toBeInstanceOf(Uint8Array)
  })

  it('connects to nothing when no snapshot is given', () => {
    const { SseBackend } = fakeSseBackendModule()
    const handlers = { onConnected: vi.fn(), onSnapshot: vi.fn() }
    new SseBackend('w1', 'note').connect(handlers as never)
    expect(handlers.onConnected).not.toHaveBeenCalled()
  })
})
