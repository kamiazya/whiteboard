// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DESTRUCTIVE_COPY } from '@/lib/destructive-copy'
import {
  getBrowserWorkspaceId,
  setBrowserWorkspaceIdForTests,
} from '../lib/browser-workspace-id.js'
import type { DocumentSnapshot } from '../lib/whiteboard-client.js'
import { LocalStoreDouble } from '../test-utils/local-index.js'
import { pickNewDocumentKind } from '../test-utils/new-document-menu.js'
import { BrowserIndexPage } from './BrowserIndexPage.js'

afterEach(cleanup)

async function seededStore(snapshots: DocumentSnapshot[]) {
  const store = new LocalStoreDouble()
  for (const s of snapshots) await store.save(s)
  return store
}

function renderPage(store: LocalStoreDouble, revision?: unknown) {
  const onOpenDocument = vi.fn()
  const page = (rev?: unknown) => (
    <MemoryRouter initialEntries={['/']}>
      <BrowserIndexPage
        index={store.index}
        loro={store.loro}
        pointer={store.pointer}
        clock={store.clock}
        onOpenDocument={onOpenDocument}
        {...(rev === undefined ? {} : { revision: rev })}
      />
    </MemoryRouter>
  )
  // React delegates events to the root; Radix portals render into
  // document.body, so the body must be the React root for portal events.
  const utils = render(page(revision), {
    container: document.body,
  })
  return { onOpenDocument, page, ...utils }
}

// The folder pane selects on click; opening goes through the preview pane's
// Open button — the same two-step the daemon page's panel uses.
async function selectCard(title: string) {
  const titles = await screen.findAllByTestId('card-title')
  const hit = titles.find((el) => el.textContent === title)
  if (!hit) throw new Error(`no card titled ${title}`)
  fireEvent.click(hit.closest('button') as HTMLElement)
}

describe('BrowserIndexPage', () => {
  it('a load that failed once stops claiming so after a retry succeeds', async () => {
    // The load effect re-runs on ordinary Backs now (`revision`), so a
    // transient failure's alert must not outlive the successful retry.
    const store = await seededStore([])
    const failingOnce = vi
      .spyOn(store.index, 'listDocuments')
      .mockRejectedValueOnce(new Error('transient'))
    const { page, rerender } = renderPage(store, 'route-a')
    await screen.findByRole('alert')
    failingOnce.mockRestore()

    rerender(page('route-b'))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(screen.getByText('What will you make first?')).toBeTruthy()
  })

  it('re-lists when the revision moves — the route came back to a page that never left', async () => {
    // react-router v7 wraps navigations in startTransition, so a Back during
    // a lazy destination's chunk load ABORTS the transition and this page is
    // never unmounted — its load effect does not re-run, and the list shows
    // the state from before whatever the navigation was about (measured:
    // onboarding create -> immediate Back rendered onboarding again over a
    // workspace holding the document). App passes the location OBJECT as
    // `revision` (its identity moves on every navigation; location.key is
    // per-entry and a Back restores the same one); any change must re-read.
    const store = await seededStore([])
    const { page, rerender } = renderPage(store, 'route-a')
    await screen.findByText('What will you make first?')

    // The create that happened before the aborted navigation.
    await store.save({
      documentId: '0CFJNRVY147ADGKPSWZ258BEHM',
      workspaceId: getBrowserWorkspaceId(),
      path: 'untitled',
      name: 'Untitled',
      updatedAt: '2026-09-05T00:00:00Z',
      kind: 'spatial',
    })

    rerender(page('route-b'))
    const titles = await screen.findAllByTestId('card-title')
    expect(titles.some((el) => el.textContent === 'Untitled')).toBe(true)
    expect(screen.queryByText('What will you make first?')).toBeNull()
  })

  it('an older in-flight load resolving after a newer one must not win', async () => {
    // `revision` re-reads on every Back, so two loads can be in flight at
    // once: a Back that fires a second Back before the first's response
    // lands would let the OLDER (route-a) response arrive after the NEWER
    // (route-b) one already rendered. The load effect's per-instance
    // `cancelled` flag is what stops that — this pins it directly rather
    // than trusting the invariant is never exercised by a test above.
    const store = await seededStore([])
    await store.save({
      documentId: '0CFJNRVY147ADGKPSWZ258BEHM',
      workspaceId: getBrowserWorkspaceId(),
      path: 'untitled',
      name: 'Untitled',
      updatedAt: '2026-09-05T00:00:00Z',
      kind: 'spatial',
    })
    const real = store.index.listDocuments.bind(store.index)
    const gates: Array<(rows: Awaited<ReturnType<typeof real>>) => void> = []
    vi.spyOn(store.index, 'listDocuments').mockImplementation(
      () => new Promise((resolve) => gates.push(resolve)),
    )

    const { page, rerender } = renderPage(store, 'route-a')
    await waitFor(() => expect(gates.length).toBe(1))

    rerender(page('route-b'))
    await waitFor(() => expect(gates.length).toBe(2))

    const rows = await real({ workspaceId: getBrowserWorkspaceId() })
    // Newer (route-b) resolves first, with the document. Assert on the
    // onboarding decision directly (`snapshots`), not on the files panel's
    // card — the panel runs its own independent `listDocuments` call
    // through the same mock, which this test never resolves.
    gates[1](rows)
    await waitFor(() => expect(screen.queryByText('What will you make first?')).toBeNull())

    // Older (route-a) resolves after, empty — must not overwrite the newer list.
    gates[0]([])
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(screen.queryByText('What will you make first?')).toBeNull()
  })

  it('re-lists when the active workspace changes under it', async () => {
    // ADR-0019's switch is an in-SPA route change, so this page stays mounted
    // across one. Its load effect keyed on the index and the clock, neither of
    // which moves when the workspace does — so the list kept showing the
    // documents of the workspace the person just left, under an address
    // naming the one they went to.
    const store = await seededStore([
      {
        documentId: '0CFJNRVY147ADGKPSWZ258BEHM',
        workspaceId: 'local',
        path: 'trip-plan',
        name: 'Trip Plan',
        updatedAt: '2026-08-01T00:00:00Z',
        kind: 'spatial',
      },
    ])
    const settled = getBrowserWorkspaceId()
    const listSpy = vi.spyOn(store.index, 'listDocuments')
    renderPage(store)
    await screen.findAllByTestId('card-title')
    const before = listSpy.mock.calls.length

    try {
      await act(async () => {
        setBrowserWorkspaceIdForTests('01BX5ZZKBKACTAV9WEVGEMMVRZ', 'second')
      })
      await waitFor(() => expect(listSpy.mock.calls.length).toBeGreaterThan(before))
    } finally {
      setBrowserWorkspaceIdForTests(settled)
    }
  })

  it('an empty list with a non-empty trash keeps the panel — restore must stay reachable', async () => {
    // Deleting the LAST document must not swap to onboarding: the Trash
    // section lives in the panel, and onboarding would hide the one
    // affordance that undoes the delete right when it is needed.
    const store = await seededStore([])
    const indexWithTrash = store.index as typeof store.index & {
      listTrash?: () => Promise<{ documentId: string; path: string; deletedAt: number }[]>
      restoreDocument?: (input: unknown) => Promise<null>
    }
    indexWithTrash.listTrash = async () => [
      { documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV', path: 'gone', deletedAt: 1_700_000 },
    ]
    indexWithTrash.restoreDocument = async () => null
    renderPage(store)

    await screen.findByTestId('trash-section')
    expect(screen.queryByText('What will you make first?')).toBeNull()
  })

  it('an empty list with an empty trash still onboards', async () => {
    const store = await seededStore([])
    const indexWithTrash = store.index as typeof store.index & {
      listTrash?: () => Promise<{ documentId: string; path: string; deletedAt: number }[]>
      restoreDocument?: (input: unknown) => Promise<null>
    }
    indexWithTrash.listTrash = async () => []
    indexWithTrash.restoreDocument = async () => null
    renderPage(store)

    await screen.findByText('What will you make first?')
  })

  it('lists documents in the folder pane with name and kind marker', async () => {
    const store = await seededStore([
      {
        documentId: '0CFJNRVY147ADGKPSWZ258BEHM',
        workspaceId: 'local',
        path: 'trip-plan',
        name: 'Trip Plan',
        updatedAt: '2026-08-01T00:00:00Z',
        kind: 'spatial',
      },
      {
        documentId: '0KPSWZ258BEHMQTX0369CFJNRV',
        workspaceId: 'local',
        path: 'meeting-notes',
        name: 'Meeting Notes',
        updatedAt: '2026-08-10T00:00:00Z',
        kind: 'markdown',
      },
    ])
    renderPage(store)

    // The panel is a file browser: path order, not recency — recency
    // ordering retired with the grid.
    const titles = await screen.findAllByTestId('card-title')
    expect(titles.map((el) => el.textContent)).toEqual(['Meeting Notes', 'Trip Plan'])
    const badges = screen.getAllByTestId('card-kind-badge')
    expect(badges[0]?.getAttribute('data-kind')).toBe('markdown')
    expect(badges[1]?.getAttribute('data-kind')).not.toBe('markdown')
  })

  it('opens a document via the preview pane after selecting its card', async () => {
    const store = await seededStore([
      {
        documentId: '0CFJNRVY147ADGKPSWZ258BEHM',
        workspaceId: 'local',
        path: 'solo',
        name: 'Solo',
        updatedAt: '2026-08-01T00:00:00Z',
        kind: 'spatial',
      },
    ])
    const { onOpenDocument } = renderPage(store)

    await selectCard('Solo')
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }))
    expect(onOpenDocument).toHaveBeenCalledWith('solo')
  })

  it('creates a markdown document from the panel toolbar and opens it', async () => {
    const store = await seededStore([
      {
        documentId: '0CFJNRVY147ADGKPSWZ258BEHM',
        workspaceId: 'local',
        path: 'existing',
        name: 'Existing',
        updatedAt: '2026-08-01T00:00:00Z',
        kind: 'spatial',
      },
    ])
    const { onOpenDocument } = renderPage(store)
    await screen.findAllByTestId('card-title')

    // Creating ends where the next thing happens. An empty document is worth
    // nothing until it is open, and every other creation path in the app
    // already opened what it made — the browser was the one that left you
    // looking at a card. Affordable now that the open folder is in the
    // address, so the way back returns to the folder rather than the root.
    await pickNewDocumentKind('markdown')

    await waitFor(async () => {
      const all = await store.listDocuments()
      expect(all.some((s) => s.kind === 'markdown')).toBe(true)
    })
    await waitFor(() => expect(onOpenDocument).toHaveBeenCalledWith('untitled'))
  })

  it('empty store shows the empty state whose action creates a spatial canvas', async () => {
    const store = new LocalStoreDouble()
    const { onOpenDocument } = renderPage(store)

    // The privacy promise is only TRUE in local mode — a swap with the
    // daemon page's line would ship a lie, so the exact string is pinned
    // per page.
    expect((await screen.findByTestId('empty-state-subtitle')).textContent).toBe(
      'Everything stays in this browser — no account, no upload.',
    )

    fireEvent.click(screen.getByRole('button', { name: /create a canvas/i }))

    await waitFor(() => expect(onOpenDocument).toHaveBeenCalledTimes(1))
    const newPath = onOpenDocument.mock.calls[0]![0] as string
    const created = (await store.listDocuments()).find((s) => s.path === newPath)
    expect(created?.kind).toBe('spatial')
    // The default pointer is by id, the callback is by path — the two
    // addresses have to agree on one document.
    expect(await store.getDefaultDocumentId()).toBe(created?.documentId)
  })

  it('a create this page performed reaches its own list without an unmount', async () => {
    // react-router wraps navigation in startTransition, so while the lazy
    // editor chunk loads this page STAYS MOUNTED — and a Back landing in
    // that window returns to this same mount. The list it renders must
    // therefore include what it just created, or the onboarding empty state
    // sticks over a store that has a document (the back-from-editor bug).
    const store = new LocalStoreDouble()
    renderPage(store)

    fireEvent.click(await screen.findByRole('button', { name: /create a canvas/i }))

    const titles = await screen.findAllByTestId('card-title')
    expect(titles).toHaveLength(1)
    expect(screen.queryByText('What will you make first?')).toBeNull()
  })

  it('empty store also offers a markdown note, creating and opening one', async () => {
    const store = new LocalStoreDouble()
    const { onOpenDocument } = renderPage(store)

    fireEvent.click(await screen.findByRole('button', { name: 'Create a markdown note' }))

    await waitFor(() => expect(onOpenDocument).toHaveBeenCalledTimes(1))
    const newPath = onOpenDocument.mock.calls[0]![0] as string
    const created = (await store.listDocuments()).find((s) => s.path === newPath)
    expect(created?.kind).toBe('markdown')
    expect(await store.getDefaultDocumentId()).toBe(created?.documentId)
  })

  it('creates exactly one canvas for two presses inside a single tick', async () => {
    // Pins the createDisabled wiring: React flushes `creating` before a
    // second click can dispatch on the now-disabled button.
    const store = new LocalStoreDouble()
    const { onOpenDocument } = renderPage(store)
    const button = await screen.findByRole('button', { name: /create a canvas/i })

    fireEvent.click(button)
    fireEvent.click(button)

    await waitFor(() => expect(onOpenDocument).toHaveBeenCalledTimes(1))
    expect(await store.listDocuments()).toHaveLength(1)
  })

  it('keeps a create entry point when the list fails to load', async () => {
    // A failed listing must not dead-end the page. The create path reads the
    // list too — to number the new path — but swallows a failed read and
    // numbers from nothing, which the index's own uniqueness check then
    // polices. Success navigates away.
    const store = new LocalStoreDouble()
    store.index.listDocuments = () => Promise.reject(new Error('idb blocked'))
    const { onOpenDocument } = renderPage(store)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('Failed to load documents from this browser.')
    fireEvent.click(screen.getByRole('button', { name: 'Create a canvas' }))
    await waitFor(() => expect(onOpenDocument).toHaveBeenCalledTimes(1))
  })

  it('surfaces a create failure and re-enables the create action', async () => {
    const store = new LocalStoreDouble()
    store.index.createDocument = () => Promise.reject(new Error('quota exceeded'))
    const { onOpenDocument } = renderPage(store)

    const button = await screen.findByRole('button', { name: /create a canvas/i })
    fireEvent.click(button)

    const alert = await screen.findByRole('alert')
    // Fixed copy — never the raw error text.
    expect(alert.textContent).toBe('Failed to create a canvas in this browser.')
    expect(onOpenDocument).not.toHaveBeenCalled()
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false))
  })

  it('the delete dialog names the kind: note for markdown, canvas for spatial', async () => {
    // The dialog copy names the OBJECT being destroyed. Calling a markdown
    // note "the canvas" is the retired container sense of the word.
    const store = await seededStore([
      {
        documentId: '0CFJNRVY147ADGKPSWZ258BEHM',
        workspaceId: 'local',
        path: 'meeting-notes',
        name: 'Meeting notes',
        updatedAt: '2026-08-01T00:00:00Z',
        kind: 'markdown',
      },
      {
        documentId: '0KPSWZ258BEHMQTX0369CFJNRV',
        workspaceId: 'local',
        path: 'trip-plan',
        name: 'Trip plan',
        updatedAt: '2026-08-02T00:00:00Z',
        kind: 'spatial',
      },
    ])
    renderPage(store)

    await selectCard('Meeting notes')
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))
    let dialog = await screen.findByRole('alertdialog')
    expect(
      within(dialog).getByText(DESTRUCTIVE_COPY['delete-document-browser']('note')),
    ).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())

    await selectCard('Trip plan')
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))
    dialog = await screen.findByRole('alertdialog')
    expect(
      within(dialog).getByText(DESTRUCTIVE_COPY['delete-document-browser']('canvas')),
    ).toBeTruthy()
  })

  it('Delete opens a dialog naming the canvas; Cancel removes nothing', async () => {
    const store = await seededStore([
      {
        documentId: '0CFJNRVY147ADGKPSWZ258BEHM',
        workspaceId: 'local',
        path: 'keep-me',
        name: 'Keep Me',
        updatedAt: '2026-08-01T00:00:00Z',
        kind: 'spatial',
      },
    ])
    renderPage(store)
    await selectCard('Keep Me')

    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText(/Delete "Keep Me"\?/)).toBeTruthy()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(await store.listDocuments()).toHaveLength(1)
    expect(screen.getAllByTestId('card-title')).toHaveLength(1)
  })

  it('clears the default pointer when the deleted canvas was the one it named', async () => {
    // A pointer left naming a deleted document does NOT degrade gracefully:
    // the editor's resume path reports 'The canvas data could not be read.'
    // and the user meets an error screen after an ordinary delete.
    const store = await seededStore([
      {
        documentId: '0CFJNRVY147ADGKPSWZ258BEHM',
        workspaceId: 'local',
        path: 'pointed-at',
        name: 'Pointed At',
        updatedAt: '2026-08-01T00:00:00Z',
        kind: 'spatial',
      },
    ])
    await store.setDefaultDocumentId('0CFJNRVY147ADGKPSWZ258BEHM')
    renderPage(store)
    await selectCard('Pointed At')

    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())

    expect(await store.getDefaultDocumentId()).toBeNull()
  })

  it('confirming Delete removes the canvas; deleting the last one returns the empty state', async () => {
    const store = await seededStore([
      {
        documentId: '0CFJNRVY147ADGKPSWZ258BEHM',
        workspaceId: 'local',
        path: 'doomed',
        name: 'Doomed',
        updatedAt: '2026-08-01T00:00:00Z',
        kind: 'spatial',
      },
    ])
    const { onOpenDocument } = renderPage(store)
    await selectCard('Doomed')

    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(await store.listDocuments()).toHaveLength(0)
    expect(await screen.findByText('What will you make first?')).toBeTruthy()
    // The delete flow must never open the canvas.
    expect(onOpenDocument).not.toHaveBeenCalled()
  })

  it('a failed delete shows the fixed error in the dialog, which stays open, and Cancel clears it', async () => {
    const store = await seededStore([
      {
        documentId: '0CFJNRVY147ADGKPSWZ258BEHM',
        workspaceId: 'local',
        path: 'sticky',
        name: 'Sticky',
        updatedAt: '2026-08-01T00:00:00Z',
        kind: 'spatial',
      },
    ])
    store.index.deleteDocument = () => Promise.reject(new Error('quota exceeded'))
    renderPage(store)
    await selectCard('Sticky')

    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))

    // Fixed copy — never the raw error text — and the dialog stays open.
    expect(
      await within(dialog).findByText('Failed to delete the document from this browser.'),
    ).toBeTruthy()
    expect(within(dialog).queryByText(/quota exceeded/)).toBeNull()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(screen.getAllByTestId('card-title')).toHaveLength(1)
  })

  it('shows each name over its own real path, which is never derived from that name', async () => {
    // Neither name carries ASCII, so a name-derived path would collapse both
    // to `untitled` / `untitled-2` — indistinguishable in the very column the
    // secondary line exists to distinguish. A local document now has a real
    // path exactly like a daemon one, and this is what shows it.
    const store = await seededStore([
      {
        documentId: '0CFJNRVY147ADGKPSWZ258BEHM',
        workspaceId: getBrowserWorkspaceId(),
        path: 'diagrams/structure',
        name: '構成図',
        updatedAt: '2026-08-02T00:00:00Z',
        kind: 'spatial',
      },
      {
        documentId: '0KPSWZ258BEHMQTX0369CFJNRV',
        workspaceId: getBrowserWorkspaceId(),
        path: 'notes/design',
        name: '設計メモ',
        updatedAt: '2026-08-01T00:00:00Z',
        kind: 'spatial',
      },
    ])
    renderPage(store)

    // The panel projects the path as STRUCTURE (folders + breadcrumb +
    // preview), not as a second line — but the same invariant holds: the
    // folder is named from the path, never from the display name.
    // Both the tree and the folder pane offer the folder; either works.
    fireEvent.click((await screen.findAllByRole('button', { name: 'Open folder diagrams' }))[0]!)
    await selectCard('構成図')
    expect((await screen.findByTestId('okf-preview')).textContent).toContain('diagrams/structure')
  })
})

// The other keeper, same rule. "Mark as Switcher": the shell does not name the
// workspace — the document browser does, as its own heading.
describe('the workspace names the page', () => {
  it('heads the page with the workspace name, and keeps Documents as the list label', async () => {
    const store = await seededStore([
      {
        documentId: '0CFJNRVY147ADGKPSWZ258BEHM',
        workspaceId: getBrowserWorkspaceId(),
        path: 'alpha',
        name: 'Alpha',
        updatedAt: '2026-08-01T00:00:00Z',
        kind: 'spatial',
      },
    ])
    await store.index.renameWorkspace({
      workspaceId: getBrowserWorkspaceId(),
      segment: 'studio',
      displayName: 'Studio',
    })

    renderPage(store)
    await screen.findByText('Alpha')

    const heading = screen.getByRole('heading', { level: 1 })
    expect(heading.textContent).toBe('Studio')
    expect(heading.className).not.toContain('sr-only')
    expect(screen.getByRole('region', { name: 'Documents' })).toBeTruthy()
  })

  it('drops the previous name on a switch, even when the new lookup does not answer', async () => {
    // The heading is a projection of a workspace, so it has to move WITH the
    // workspace. The name lookup is deliberately its own chain — a name that
    // will not load must not surface as "Failed to load documents" — and its
    // `.catch` swallowed the failure without clearing what was on screen. The
    // result is the worst reading available: the new workspace, under the old
    // workspace's name, indefinitely and with nothing saying so.
    const store = await seededStore([
      {
        documentId: '0CFJNRVY147ADGKPSWZ258BEHM',
        workspaceId: getBrowserWorkspaceId(),
        path: 'alpha',
        name: 'Alpha',
        updatedAt: '2026-08-01T00:00:00Z',
        kind: 'spatial',
      },
    ])
    await store.index.renameWorkspace({
      workspaceId: getBrowserWorkspaceId(),
      segment: 'studio',
      displayName: 'Studio',
    })

    // Answers the first read and fails every one after it: the name has to be
    // ON screen before a stale one can be the defect.
    let reads = 0
    const flakyIndex = new Proxy(store.index, {
      get(target, prop, receiver) {
        if (prop === 'resolveWorkspace') {
          return (input: Parameters<typeof store.index.resolveWorkspace>[0]) => {
            reads += 1
            return reads === 1
              ? store.index.resolveWorkspace(input)
              : Promise.reject(new Error('index read failed'))
          }
        }
        const value = Reflect.get(target, prop, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })

    render(
      <MemoryRouter initialEntries={['/']}>
        <BrowserIndexPage
          index={flakyIndex}
          loro={store.loro}
          pointer={store.pointer}
          clock={store.clock}
          onOpenDocument={vi.fn()}
        />
      </MemoryRouter>,
      { container: document.body },
    )
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Studio'),
    )

    await act(async () => {
      setBrowserWorkspaceIdForTests('0DGKPSWZ258BEHM1CFJNRVY147', 'other-space')
    })

    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1 }).textContent).not.toBe('Studio'),
    )
    // Not merely "not Studio": the handle is what the address carries, and it
    // is true about the workspace now on screen.
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('other-space')
  })

  it('falls back through the identity layers rather than showing a raw id', async () => {
    const store = await seededStore([
      {
        documentId: '0CFJNRVY147ADGKPSWZ258BEHM',
        workspaceId: getBrowserWorkspaceId(),
        path: 'alpha',
        name: 'Alpha',
        updatedAt: '2026-08-01T00:00:00Z',
        kind: 'spatial',
      },
    ])
    await store.index.renameWorkspace({
      workspaceId: getBrowserWorkspaceId(),
      segment: 'studio',
    })

    renderPage(store)
    await screen.findByText('Alpha')

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('studio')
  })
})
