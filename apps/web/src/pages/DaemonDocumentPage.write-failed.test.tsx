import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { act, cleanup, render as rtlRender, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as daemonApiClient from '../lib/daemon-api-client.js'
import { getShellConnection } from '../lib/shell-status-store.js'
import {
  latestEditorProps,
  resetCapturedEditorProps,
} from '../test-utils/capturing-spatial-editor.js'
import { FakeDocumentBackend, MemoryRouterWrapper } from '../test-utils/daemon-page-harness.js'
import { DaemonDocumentPage } from './DaemonDocumentPage.js'

vi.mock('../lib/replica-refresh.js', async () =>
  (await import('../test-utils/daemon-page-harness.js')).replicaRefreshMock(),
)
vi.mock('../lib/daemon-api-client.js', async (importOriginal) =>
  (await import('../test-utils/daemon-page-harness.js')).daemonApiClientMock(importOriginal, [
    'listWorkspaces',
    'listDocuments',
  ]),
)
vi.mock('../components/spatial-editor/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../components/spatial-editor/index.js')>()
  const { CapturingSpatialEditor } = await import('../test-utils/capturing-spatial-editor.js')
  return { ...actual, SpatialEditor: CapturingSpatialEditor }
})

const created: FakeDocumentBackend[] = []

// The favicon itself is a canvas jsdom cannot draw; the installed app's
// badge is set from the same status, and only for `unsaved`.
const setAppBadge = vi.fn(() => Promise.resolve())
const clearAppBadge = vi.fn(() => Promise.resolve())

async function renderPageAndEdit(): Promise<FakeDocumentBackend> {
  await act(async () => {
    rtlRender(
      <DaemonDocumentPage
        daemonBaseUrl="http://127.0.0.1:3099"
        createBackend={() => {
          const backend = new FakeDocumentBackend()
          created.push(backend)
          return backend
        }}
      />,
      { wrapper: MemoryRouterWrapper, container: document.body },
    )
  })
  await waitFor(() => expect(screen.getByTestId('stub-spatial-editor')).toBeTruthy())
  await waitFor(() =>
    expect(getShellConnection()?.state).toEqual({ keeper: 'daemon', session: 'synced' }),
  )
  const node = textNode({ id: 'n-a', x: 0, y: 0, width: 100, height: 40, text: 'A' })
  await act(async () => {
    latestEditorProps()?.onChange?.({ nodes: [node], edges: [] }, { kind: 'create-node', node })
  })
  const backend = created[0]
  if (backend === undefined) throw new Error('the page created no backend')
  await waitFor(() => expect(backend.pushed.length).toBeGreaterThan(0))
  return backend
}

describe('DaemonDocumentPage when a write is refused', () => {
  beforeEach(() => {
    window.localStorage.clear()
    resetCapturedEditorProps()
    created.length = 0
    Object.defineProperty(navigator, 'setAppBadge', { value: setAppBadge, configurable: true })
    Object.defineProperty(navigator, 'clearAppBadge', { value: clearAppBadge, configurable: true })
    vi.mocked(daemonApiClient.listWorkspaces).mockResolvedValue({
      workspaces: [{ workspaceId: 'w1' }],
    })
    vi.mocked(daemonApiClient.listDocuments).mockResolvedValue({
      documents: [
        { path: 'main', documentId: 'id-main', updatedAt: '2026-01-01', kind: 'spatial' },
      ],
    })
  })
  afterEach(() => {
    cleanup()
    Reflect.deleteProperty(navigator, 'setAppBadge')
    Reflect.deleteProperty(navigator, 'clearAppBadge')
    vi.clearAllMocks()
  })

  it('reads a refused push as write-failed on the shell and unsaved on the badge', async () => {
    const backend = await renderPageAndEdit()
    expect(setAppBadge).not.toHaveBeenCalled()
    await act(async () => {
      backend.handlers?.onAuthError?.('push')
      backend.handlers?.onError?.('storage-failure')
    })
    await waitFor(() =>
      expect(getShellConnection()?.state).toEqual({ keeper: 'daemon', session: 'write-failed' }),
    )
    expect(setAppBadge).toHaveBeenCalled()
  })

  it('returns to synced and clears the badge once a write lands', async () => {
    const backend = await renderPageAndEdit()
    await act(async () => {
      backend.handlers?.onAuthError?.('push')
      backend.handlers?.onError?.('storage-failure')
    })
    await waitFor(() => expect(setAppBadge).toHaveBeenCalled())
    clearAppBadge.mockClear()
    await act(async () => {
      backend.handlers?.onWritesLanded?.()
    })
    await waitFor(() =>
      expect(getShellConnection()?.state).toEqual({ keeper: 'daemon', session: 'synced' }),
    )
    expect(clearAppBadge).toHaveBeenCalled()
  })
})
