/**
 * The browser keeper's own file-reference case. The shared scenarios (other
 * documents offered as id refs under their label, an id ref opening its
 * current path, the missing-ref rule) run against both keepers in
 * `document-page.contract.tsx`. What is left here is where the keepers
 * deliberately differ: an id the browser's list does not carry yet is a
 * document the list has not caught up with, so following it does NOTHING
 * rather than navigate to nowhere — the daemon page instead passes an unknown
 * ref through as a legacy path (its own file has that case).
 */
import { act, cleanup, render as rtlRender, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getBrowserWorkspaceId } from '../lib/browser-workspace-id.js'
import {
  latestEditorProps,
  resetCapturedEditorProps,
} from '../test-utils/capturing-spatial-editor.js'
import { InMemoryLoroStore, LocalStoreDouble } from '../test-utils/local-index.js'

vi.mock('../components/spatial-editor/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../components/spatial-editor/index.js')>()
  const { CapturingSpatialEditor } = await import('../test-utils/capturing-spatial-editor.js')
  return { ...actual, SpatialEditor: CapturingSpatialEditor }
})

vi.mock('../lib/browser-backend.js', async () => {
  const { FakeBrowserBackend } = await import('../test-utils/fake-browser-backend.js')
  return { BrowserBackend: FakeBrowserBackend }
})

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
        path: '/w/:workspace/d/*',
        element: (
          <BrowserDocumentPage
            store={store.index}
            pointer={store.pointer}
            clock={store.clock}
            loro={new InMemoryLoroStore()}
            initialPath="here"
          />
        ),
      },
    ],
    { initialEntries: ['/w/default/d/here'] },
  )
  await act(async () => {
    rtlRender(<RouterProvider router={router} />)
  })
  await waitFor(() => {
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Here')
  })
  await waitFor(() => expect(latestEditorProps()?.fileRefOptions?.length ?? 0).toBeGreaterThan(0))
  return router
}

afterEach(() => {
  cleanup()
  resetCapturedEditorProps()
})

describe('BrowserDocumentPage file references', () => {
  it('leaves the address bar alone for a reference the list does not carry', async () => {
    const router = await mountPage(await seededStore())
    const before = router.state.location.key
    await act(async () => {
      latestEditorProps()?.onOpenFileRef?.('01ARZ3NDEKTSV4RRFFQ69G5FZZ')
    })
    // On the KEY, not the pathname: navigating to an id-shaped URL and then
    // having the URL→document effect repair it lands back on this same
    // pathname, so a pathname assertion cannot tell the two apart — and the
    // difference is a junk history entry the user has to press Back through.
    expect(router.state.location.pathname).toBe('/w/default/d/here')
    expect(router.state.location.key).toBe(before)
  })
})
