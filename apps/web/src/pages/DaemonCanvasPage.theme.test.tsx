/**
 * Confirms DaemonCanvasPage threads its resolved theme into `SpatialEditor`
 * — mirrors BrowserLocalCanvasPage.theme.test.tsx; each page gets its own
 * wiring test so a regression in one page's prop threading is not masked by
 * the other.
 */
import type {
  CanvasBackend,
  CanvasBackendHandlers,
} from '@kamiazya/whiteboard-mcp/browser-contract'
import {
  act,
  cleanup,
  type RenderOptions,
  render as rtlRender,
  screen,
  waitFor,
} from '@testing-library/react'
import type { ReactElement } from 'react'
import { forwardRef } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as daemonApiClient from '../lib/daemon-api-client.js'

// The page now reads useNavigate (Settings navigation), so every render
// needs a Router ancestor — wrapping once here keeps the existing
// `render(<DaemonCanvasPage .../>)` call sites throughout this file unchanged.
function render(ui: ReactElement, options?: RenderOptions) {
  return rtlRender(<MemoryRouter initialEntries={['/']}>{ui}</MemoryRouter>, options)
}

const capturedThemes: unknown[] = []

vi.mock('../components/spatial-editor/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../components/spatial-editor/index.js')>()
  const CapturingSpatialEditor = forwardRef<unknown, Parameters<typeof actual.SpatialEditor>[0]>(
    (props, ref) => {
      capturedThemes.push(props.theme)
      // biome-ignore lint/suspicious/noExplicitAny: forwarding to the real forwardRef component
      return <actual.SpatialEditor {...props} ref={ref as any} />
    },
  )
  return { ...actual, SpatialEditor: CapturingSpatialEditor }
})

vi.mock('../lib/daemon-api-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/daemon-api-client.js')>()
  return {
    ...actual,
    listWorkspaces: vi.fn(),
    listCanvases: vi.fn(),
    createCanvas: vi.fn(),
  }
})

const { DaemonCanvasPage } = await import('./DaemonCanvasPage.js')
const { THEME_STORAGE_KEY } = await import('../hooks/useThemeMode.js')

const mockListWorkspaces = vi.mocked(daemonApiClient.listWorkspaces)
const mockListCanvases = vi.mocked(daemonApiClient.listCanvases)

class FakeBackend implements CanvasBackend {
  handlers: CanvasBackendHandlers | null = null
  connect(handlers: CanvasBackendHandlers): void {
    this.handlers = handlers
    handlers.onConnected()
    const { LoroDoc } = require('loro-crdt') as typeof import('loro-crdt')
    handlers.onSnapshot(new LoroDoc().export({ mode: 'snapshot' }))
  }
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

function makeCreateBackend() {
  return () => new FakeBackend()
}

const DAEMON_BASE_URL = 'http://127.0.0.1:3099'

describe('DaemonCanvasPage theme wiring', () => {
  beforeEach(() => {
    capturedThemes.length = 0
    window.localStorage.clear()
    mockListWorkspaces.mockResolvedValue({ workspaces: [{ workspaceId: 'w1' }] })
    mockListCanvases.mockResolvedValue({
      canvases: [{ slug: 'main', id: 'id-main', updatedAt: '2026-01-01', kind: 'spatial' }],
    })
  })
  afterEach(() => {
    cleanup()
    window.localStorage.clear()
    vi.clearAllMocks()
  })

  it('threads resolvedTheme=dark into SpatialEditor when the stored preference is dark', async () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark')
    await act(async () => {
      render(
        <DaemonCanvasPage daemonBaseUrl={DAEMON_BASE_URL} createBackend={makeCreateBackend()} />,
        { container: document.body },
      )
    })
    await waitFor(() => expect(screen.getByTestId('spatial-editor-container')).toBeTruthy())
    expect(capturedThemes).toContain('dark')
  })

  it('threads resolvedTheme=light into SpatialEditor when the stored preference is light', async () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'light')
    await act(async () => {
      render(
        <DaemonCanvasPage daemonBaseUrl={DAEMON_BASE_URL} createBackend={makeCreateBackend()} />,
        { container: document.body },
      )
    })
    await waitFor(() => expect(screen.getByTestId('spatial-editor-container')).toBeTruthy())
    expect(capturedThemes).toContain('light')
    expect(capturedThemes).not.toContain('dark')
  })
})
