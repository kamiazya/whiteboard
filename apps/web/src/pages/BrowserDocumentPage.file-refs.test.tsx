/**
 * File-reference identity on the browser page, the sibling of
 * DaemonDocumentPage.file-refs.test.tsx: a file node references the target
 * document's immutable id (rename- and move-safe, ADR-0008) while the address
 * bar names a path, so opening one crosses that boundary by lookup. An id the
 * list does not carry yet is a no-op rather than a navigation to nowhere.
 */
import { act, cleanup, render as rtlRender, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SpatialEditorProps } from '../components/spatial-editor/index.js'
import { getBrowserWorkspaceId } from '../lib/browser-workspace-id.js'
import type { LoroLoadResult } from '../lib/loro-store.js'
import { LocalStoreDouble } from '../test-utils/local-index.js'
import type { LoroStoreLike } from './use-browser-document-controller.js'

// Captures the editor's file-ref props without mounting the real canvas —
// what this file tests is the page's wiring, not the editor's rendering.
let capturedEditorProps: SpatialEditorProps | null = null
vi.mock('../components/spatial-editor/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../components/spatial-editor/index.js')>()
  return {
    ...actual,
    SpatialEditor: (props: SpatialEditorProps) => {
      capturedEditorProps = props
      return <div data-testid="stub-spatial-editor" />
    },
  }
})

vi.mock('../lib/browser-backend.js', () => ({
  BrowserBackend: class {
    connect(handlers: { onConnected: () => void }) {
      handlers.onConnected()
    }
    disconnect() {}
    pushLocalUpdate() {
      return Promise.resolve()
    }
    getFile() {
      return Promise.resolve(null)
    }
    putFile() {
      return Promise.resolve()
    }
    sendClientReady() {}
    sendExportResponse() {}
  },
}))

class FakeLoroStore implements LoroStoreLike {
  private byId = new Map<string, Uint8Array>()
  async save(id: string, bytes: Uint8Array): Promise<void> {
    this.byId.set(id, bytes)
  }
  createEmptySnapshot(): Uint8Array {
    return new Uint8Array([1, 2, 3])
  }
  async load(id: string): Promise<LoroLoadResult> {
    const bytes = this.byId.get(id)
    if (bytes === undefined) return { kind: 'not-found' }
    return { kind: 'ok', snapshot: bytes }
  }
}

const { BrowserDocumentPage } = await import('./BrowserDocumentPage.js')

const HERE_ID = '005AFMSY38DJQW16BGNTZ49EKR'
const TARGET_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

async function seededStore(): Promise<LocalStoreDouble> {
  const store = new LocalStoreDouble()
  await store.setDefaultDocumentId(HERE_ID)
  await store.save({
    documentId: HERE_ID,
    workspaceId: getBrowserWorkspaceId(),
    path: 'here',
    name: 'Here',
    updatedAt: '2026-05-24T00:00:00.000Z',
    kind: 'spatial',
  })
  await store.save({
    documentId: TARGET_ID,
    workspaceId: getBrowserWorkspaceId(),
    // Deliberately unlike both the id and the display name: a fixture where
    // any of the three could stand in for another proves nothing about which
    // one the wiring actually used.
    path: 'archive/target',
    name: 'Target',
    updatedAt: '2026-05-25T00:00:00.000Z',
    kind: 'spatial',
  })
  return store
}

async function mountPage(store: LocalStoreDouble) {
  const router = createMemoryRouter(
    [
      {
        path: '/w/:workspace/document/*',
        element: (
          <BrowserDocumentPage
            store={store.index}
            pointer={store.pointer}
            clock={store.clock}
            loro={new FakeLoroStore()}
            initialPath="here"
          />
        ),
      },
    ],
    { initialEntries: ['/w/default/document/here'] },
  )
  await act(async () => {
    rtlRender(<RouterProvider router={router} />)
  })
  await waitFor(() => {
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Here')
  })
  await waitFor(() => expect(capturedEditorProps?.fileRefOptions?.length).toBeGreaterThan(0))
  return router
}

afterEach(() => {
  cleanup()
  capturedEditorProps = null
})

describe('BrowserDocumentPage file references', () => {
  it('offers every other document by id, labeled with its name', async () => {
    await mountPage(await seededStore())
    expect(capturedEditorProps?.fileRefOptions).toEqual([
      { file: TARGET_ID, label: 'Target', kind: 'spatial' },
    ])
  })

  it('opens a reference by resolving its id to that document’s current path', async () => {
    const router = await mountPage(await seededStore())
    await act(async () => {
      capturedEditorProps?.onOpenFileRef?.(TARGET_ID)
    })
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/w/default/document/archive/target')
    })
  })

  it('leaves the address bar alone for a reference the list does not carry', async () => {
    const router = await mountPage(await seededStore())
    const before = router.state.location.key
    await act(async () => {
      capturedEditorProps?.onOpenFileRef?.('01ARZ3NDEKTSV4RRFFQ69G5FZZ')
    })
    // On the KEY, not the pathname: navigating to an id-shaped URL and then
    // having the URL→document effect repair it lands back on this same
    // pathname, so a pathname assertion cannot tell the two apart — and the
    // difference is a junk history entry the user has to press Back through.
    expect(router.state.location.pathname).toBe('/w/default/document/here')
    expect(router.state.location.key).toBe(before)
  })
})
