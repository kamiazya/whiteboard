/**
 * Confirms DaemonCanvasPage supplies WorkspaceTopBar's `getThumbnailBlob`.
 *
 * The prop is optional, and `useSaveVersion` silently skips the thumbnail
 * upload when it is absent — so an unwired page produces a daemon whose
 * every canvas answers 204 on latest-thumbnail forever, with no error
 * anywhere to notice. Mirrors DaemonCanvasPage.theme.test.tsx: a per-page
 * prop-threading test, because a regression here is invisible at runtime.
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
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as daemonApiClient from '../lib/daemon-api-client.js'

// The page now reads useNavigate (Settings navigation), so every render
// needs a Router ancestor — wrapping once here keeps the existing
// `render(<DaemonCanvasPage .../>)` call sites throughout this file unchanged.
function render(ui: ReactElement, options?: RenderOptions) {
  return rtlRender(<MemoryRouter initialEntries={['/']}>{ui}</MemoryRouter>, options)
}

const capturedProps: { getThumbnailBlob?: () => Promise<Blob | null> }[] = []

// DaemonCanvasPage imports this as a DEFAULT export, so overriding only a
// named one would capture nothing and the test would fail for the wrong
// reason.
vi.mock('../components/WorkspaceTopBar.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../components/WorkspaceTopBar.js')>()
  const Capturing = (props: Parameters<typeof actual.default>[0]) => {
    capturedProps.push(props)
    return <actual.default {...props} />
  }
  return { ...actual, default: Capturing }
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

const DAEMON_BASE_URL = 'http://127.0.0.1:3099'

describe('DaemonCanvasPage thumbnail wiring', () => {
  beforeEach(() => {
    capturedProps.length = 0
    mockListWorkspaces.mockResolvedValue({ workspaces: [{ workspaceId: 'w1' }] })
    mockListCanvases.mockResolvedValue({
      canvases: [{ path: 'main', id: 'id-main', updatedAt: '2026-01-01', kind: 'spatial' }],
    })
  })
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('gives WorkspaceTopBar a getThumbnailBlob so a saved version gets a thumbnail', async () => {
    await act(async () => {
      render(
        <DaemonCanvasPage
          daemonBaseUrl={DAEMON_BASE_URL}
          createBackend={() => new FakeBackend()}
        />,
        { container: document.body },
      )
    })
    await waitFor(() => expect(screen.getByTestId('spatial-editor-container')).toBeTruthy())
    await waitFor(() => expect(capturedProps.length).toBeGreaterThan(0))

    const withThumbnail = capturedProps.filter((p) => typeof p.getThumbnailBlob === 'function')
    expect(withThumbnail.length).toBeGreaterThan(0)
  })
})
