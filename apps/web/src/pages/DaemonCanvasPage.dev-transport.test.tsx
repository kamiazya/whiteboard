/**
 * That the dev transport override is actually CONSULTED when the page builds
 * a backend.
 *
 * Worth its own case because the override is otherwise unfalsifiable: a
 * developer sets it, sees WebSocket anyway, and has no way to tell whether the
 * override is broken or their assumption about the transport was wrong. The
 * unit test beside it only proves the value is read from storage; this proves
 * the page acts on it.
 */
import { cleanup, render as rtlRender, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as daemonApiClient from '../lib/daemon-api-client.js'
import { DEV_TRANSPORT_OVERRIDE_KEY } from '../lib/dev-transport-override.js'
import { DaemonCanvasPage } from './DaemonCanvasPage.js'

vi.mock('../lib/daemon-api-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/daemon-api-client.js')>()
  return { ...actual, listWorkspaces: vi.fn(), listCanvases: vi.fn() }
})

const built: string[] = []

function stubBackend(name: string) {
  return class {
    constructor() {
      built.push(name)
    }
    connect(): void {}
    disconnect(): void {}
    pushLocalUpdate(): void {}
    getFile(): Promise<Blob | null> {
      return Promise.resolve(null)
    }
    putFile(): Promise<void> {
      return Promise.resolve()
    }
    sendClientReady(): void {}
    sendExportResponse(): void {}
  }
}

vi.mock('@kamiazya/whiteboard-mcp/daemon-backend', () => ({
  DaemonBackend: stubBackend('websocket'),
}))
vi.mock('@kamiazya/whiteboard-mcp/sse-backend', () => ({ SseBackend: stubBackend('sse') }))

const mockListWorkspaces = vi.mocked(daemonApiClient.listWorkspaces)
const mockListCanvases = vi.mocked(daemonApiClient.listCanvases)

function Wrapper({ children }: { children: ReactNode }) {
  return <MemoryRouter initialEntries={['/']}>{children}</MemoryRouter>
}

describe('DaemonCanvasPage transport selection', () => {
  beforeEach(() => {
    window.localStorage.clear()
    built.length = 0
    mockListWorkspaces.mockResolvedValue({ workspaces: [{ workspaceId: 'w1' }] })
    mockListCanvases.mockResolvedValue({
      canvases: [{ slug: 'main', id: 'id-main', updatedAt: '2026-01-01', kind: 'spatial' }],
    })
  })
  afterEach(() => {
    cleanup()
    window.localStorage.clear()
  })

  it('takes WebSocket for an http page, as it always has', async () => {
    // The baseline the override exists to escape: jsdom serves the page over
    // http, so the real rule picks WebSocket and the SSE path is unreachable.
    rtlRender(<DaemonCanvasPage daemonBaseUrl="http://127.0.0.1:3099" token="t" />, {
      wrapper: Wrapper,
    })
    await waitFor(() => expect(built.length).toBeGreaterThan(0))
    expect(built).toContain('websocket')
    expect(built).not.toContain('sse')
  })

  it('takes the transport a developer pinned instead', async () => {
    window.localStorage.setItem(DEV_TRANSPORT_OVERRIDE_KEY, 'sse')
    rtlRender(<DaemonCanvasPage daemonBaseUrl="http://127.0.0.1:3099" token="t" />, {
      wrapper: Wrapper,
    })
    await waitFor(() => expect(built.length).toBeGreaterThan(0))
    expect(built).toContain('sse')
    expect(built).not.toContain('websocket')
  })
})
