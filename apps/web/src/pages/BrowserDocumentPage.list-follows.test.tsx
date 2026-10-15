/**
 * The browser page's document list follows the workspace it is open in. A
 * document another tab creates is written by that tab's index and announced
 * on the workspace's channel by path — no bytes reach the record this page
 * syncs — so the list every link, reference and embed resolves against has
 * to re-read on the announcement, not wait for this tab's next edit.
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getBrowserWorkspaceId } from '../lib/browser-workspace-id.js'
import type { LoroLoadResult } from '../lib/loro-store.js'
import { announceDocumentCreated } from '../lib/workspace-broadcast.js'
import { BrowserStoreDouble } from '../test-utils/browser-store-fixture.js'
import {
  latestEditorProps,
  resetCapturedEditorProps,
} from '../test-utils/capturing-spatial-editor.js'
import type { LoroStoreLike } from './use-browser-document-controller.js'

const MAIN = '005AFMSY38DJQW16BGNTZ49EKR'
const PLAN = '01ARZ3NDEKTSV4RRFFQ69G5FB0'

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

vi.mock('../lib/browser-backend.js', () => ({
  BrowserBackend: class {
    connect(handlers: { onConnected: () => void }) {
      handlers.onConnected()
    }
    disconnect() {}
    pushLocalUpdate() {
      return Promise.resolve()
    }
    sendClientReady() {}
  },
}))

vi.mock('../components/spatial-editor/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../components/spatial-editor/index.js')>()
  const { CapturingSpatialEditor } = await import('../test-utils/capturing-spatial-editor.js')
  return { ...actual, SpatialEditor: CapturingSpatialEditor }
})

/**
 * What this browser's reference graph answers. Stood in for so the case is
 * about WHEN the page asks, which is the page's; what the graph answers is
 * `browser-backlinks.browser.test.tsx`'s.
 */
const graph = vi.hoisted(() => ({
  answer: { backlinks: [] as unknown[], unlinkedMentions: [] as unknown[] },
}))

vi.mock('../lib/browser-backlinks.js', () => ({
  browserBacklinksReader: () => async () => graph.answer,
}))

const { BrowserDocumentPage } = await import('./BrowserDocumentPage.js')

describe('BrowserDocumentPage document list follows the workspace', () => {
  let store: BrowserStoreDouble

  beforeEach(async () => {
    resetCapturedEditorProps()
    graph.answer = { backlinks: [], unlinkedMentions: [] }
    store = new BrowserStoreDouble()
    await store.setDefaultDocumentId(MAIN)
    await store.save({
      documentId: MAIN,
      workspaceId: getBrowserWorkspaceId(),
      path: 'main',
      name: 'Main',
      updatedAt: '2026-05-24T00:00:00.000Z',
      kind: 'spatial' as const,
    })
  })

  afterEach(cleanup)

  async function openMain(): Promise<void> {
    const router = createMemoryRouter(
      [
        {
          path: '/w/:workspace/d/*',
          element: (
            <BrowserDocumentPage
              store={store.index}
              pointer={store.pointer}
              clock={store.clock}
              loro={new FakeLoroStore()}
              initialPath="main"
            />
          ),
        },
      ],
      { initialEntries: ['/w/default/d/main'] },
    )
    await act(async () => {
      render(<RouterProvider router={router} />)
    })
    await waitFor(() => expect(latestEditorProps()?.missingFileRef?.(MAIN)).toBe(false))
  }

  it('stops calling a document missing once another tab creates it', async () => {
    await openMain()
    expect(latestEditorProps()?.missingFileRef?.(PLAN)).toBe(true)

    await store.save({
      documentId: PLAN,
      workspaceId: getBrowserWorkspaceId(),
      path: 'plan',
      name: 'Plan',
      updatedAt: '2026-05-25T00:00:00.000Z',
      kind: 'markdown' as const,
    })
    announceDocumentCreated(getBrowserWorkspaceId(), 'plan')

    await waitFor(() => expect(latestEditorProps()?.missingFileRef?.(PLAN)).toBe(false))
  })

  it('counts a backlink another tab saves while the document is open', async () => {
    await openMain()
    await waitFor(() => screen.getByRole('button', { name: 'Connections (0)' }))

    graph.answer = {
      backlinks: [{ documentId: PLAN, path: 'plan', contexts: ['see [[main]]'] }],
      unlinkedMentions: [],
    }
    await store.save({
      documentId: PLAN,
      workspaceId: getBrowserWorkspaceId(),
      path: 'plan',
      name: 'Plan',
      updatedAt: '2026-05-25T00:00:00.000Z',
      kind: 'markdown' as const,
    })
    announceDocumentCreated(getBrowserWorkspaceId(), 'plan')

    await waitFor(() => screen.getByRole('button', { name: 'Connections (1)' }))
  })
})
