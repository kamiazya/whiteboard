/**
 * A destructive dialog this page holds open must not outlive the document it
 * was opened about.
 *
 * `confirmDelete` is a bare boolean, and `triggerCleanup()` acts on whatever
 * document the controller currently holds. Nothing binds the two together —
 * so a dialog opened on A and confirmed after a switch deletes B.
 *
 * The switch needs no unmount, and that is by design rather than by accident.
 * `App.tsx` says it at the mount site: "The editor mounts only for a document
 * route, whose in-editor switching it keeps owning." A URL that disagrees
 * with the loaded document calls `switchDocument` in place, which is what
 * browser Back does — and ADR-0019's route change is not blocked by a Radix
 * dialog.
 *
 * The same shape has now been found on four screens. The panel's rename
 * dialog (workspace scope), the branch chip's delete (document scope), the
 * markdown hook's write handle, and this one — a document delete addressed at
 * a document nobody asked about.
 */

// jsdom + fake-indexeddb: the subject is page wiring across a route-driven
// switch, not browser layout — the spatial editor is mocked out entirely.
import 'fake-indexeddb/auto'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import {
  act,
  cleanup,
  configure,
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import type { ReactElement } from 'react'
import { useEffect } from 'react'
import { MemoryRouter, useNavigate } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { documentPath } from '../lib/app-routes.js'
import { BROWSER_DEFAULT_SEGMENT } from '../lib/browser-idb.js'
import { IdbDocumentIndex } from '../lib/idb-document-index.js'
import { listLocalDocuments } from '../lib/local-document-summary.js'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { seedIdbDocument } from '../test-utils/seed-idb-document.js'
// The lazy WorkspaceTopBar chunk, transformed in the collection phase so a
// findBy* on its kebab never pays the load (integrator-flow.md's
// lazy()-vs-findBy* family).
import '../components/WorkspaceTopBar.js'

claimIsolatedWhiteboardDb('browserdocumentpage-dialog-outlives-document')

// Captured so a test can wait for the page to be fully WIRED, not merely
// painted. It matters: the URL -> document effect drops a navigation that
// lands before `listDocuments` has answered and never retries it (that
// effect's own comment says why), so a switch issued too early is a silent
// no-op — measured, ten samples over three seconds all still on the first
// document.
let editorMounted: (() => void) | null = null
/** The editor's own way in to the full-screen body surface. */
let openInEditor: ((nodeId: string, text: string) => void) | null = null
vi.mock('../components/spatial-editor/index.js', () => ({
  SpatialEditor: (props: {
    canvas: SpatialCanvas
    onChange?: () => void
    onOpenInEditor?: (nodeId: string, text: string) => void
  }) => {
    editorMounted = props.onChange ?? null
    openInEditor = props.onOpenInEditor ?? null
    return null
  },
}))

const { BrowserDocumentPage } = await import('./BrowserDocumentPage.js')

// Stands in for the document browser: the only thing it does to this page is
// change the URL, which is exactly what picking a document there does.
let navigateTo: ((to: string) => void) | null = null
function NavigationProbe() {
  const navigate = useNavigate()
  useEffect(() => {
    navigateTo = navigate
    return () => {
      navigateTo = null
    }
  }, [navigate])
  return null
}

function render(ui: ReactElement) {
  return rtlRender(
    <div style={{ height: '100vh' }}>
      <MemoryRouter initialEntries={['/']}>
        <NavigationProbe />
        {ui}
      </MemoryRouter>
    </div>,
  )
}

async function openDeleteDialog(): Promise<HTMLElement> {
  const kebab = await screen.findByRole('button', { name: 'More actions' })
  fireEvent.pointerDown(kebab, { button: 0, ctrlKey: false })
  const item = await screen.findByRole('menuitem', { name: /^delete$/i })
  fireEvent.pointerUp(item)
  return screen.findByRole('alertdialog')
}

/**
 * An index whose duplicate-time create never settles until the test releases
 * it, so a test can stand between a duplicate failing for one document and
 * its error being reported.
 *
 * Only the duplicate's create is held. Seeding goes through the same method,
 * so the switch is armed explicitly rather than by counting calls.
 */
class HeldDuplicateIndex extends IdbDocumentIndex {
  holdNextCreate = false
  private release: () => void = () => {}
  private readonly gate = new Promise<void>((resolve) => {
    this.release = resolve
  })
  private markAttempted: () => void = () => {}
  readonly attempted = new Promise<void>((resolve) => {
    this.markAttempted = resolve
  })

  releaseFailure(): void {
    this.release()
  }

  override async createDocument(
    input: Parameters<IdbDocumentIndex['createDocument']>[0],
  ): ReturnType<IdbDocumentIndex['createDocument']> {
    if (!this.holdNextCreate) return super.createDocument(input)
    this.markAttempted()
    await this.gate
    throw new Error('the browser refused the write')
  }
}

// fake-indexeddb behind the DocumentStore port costs several round trips per
// read; the sibling multi-document suite carries the same budgets for the
// same reason.
vi.setConfig({ testTimeout: 30_000 })
configure({ asyncUtilTimeout: 15_000 })

const OPENED_ABOUT = 'The document the dialog was opened about'
const ARRIVED_AFTER = 'The document that arrived while it was open'

describe('a destructive dialog does not outlive its document', () => {
  beforeEach(async () => {
    await clearWhiteboardDb()
  })

  afterEach(() => {
    cleanup()
  })

  it('confirming a delete opened on one document does not delete the one now on screen', async () => {
    const store = new IdbDocumentIndex()
    await seedIdbDocument(store, {
      path: 'opened-about',
      name: OPENED_ABOUT,
      kind: 'spatial',
      makeDefault: true,
    })
    await seedIdbDocument(store, {
      path: 'arrived-after',
      name: ARRIVED_AFTER,
      kind: 'spatial',
    })

    render(<BrowserDocumentPage store={store} />)
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1 }).textContent).toContain(OPENED_ABOUT),
    )

    await waitFor(() =>
      expect(
        editorMounted,
        'the page is not wired yet; a switch now would be dropped',
      ).not.toBeNull(),
    )
    await waitFor(async () => {
      expect((await listLocalDocuments(store)).map((r) => r.path)).toHaveLength(2)
    })

    await openDeleteDialog()

    // The switch. Browser Back does this with the dialog still open.
    await act(async () => {
      navigateTo?.(documentPath(BROWSER_DEFAULT_SEGMENT, 'arrived-after'))
    })
    // Polled OUTSIDE React's act scope, and read from the document text
    // rather than by role. Both are measured rather than stylistic:
    //
    // - `waitFor` runs its whole body inside act, and the switch is a chain of
    //   effect -> IndexedDB promise -> effect that does not advance there.
    //   Ten act-wrapped samples across three seconds all stayed on the first
    //   document; a plain unwrapped wait switched inside two.
    // - the open dialog marks the page behind it aria-hidden, so every
    //   heading on it leaves the accessibility tree while it stands, and a
    //   role query reports "never switched" for a page that did.
    for (let i = 0; i < 100 && !document.body.textContent?.includes(ARRIVED_AFTER); i++) {
      await new Promise((r) => setTimeout(r, 50))
    }
    await act(async () => {})
    expect(
      document.body.textContent,
      'the page never switched, so the DELETE case would pass without exercising anything',
    ).toContain(ARRIVED_AFTER)

    // The dialog named the document that left. It has no subject any more, so
    // it must not still be standing over a document it was never about.
    expect(
      screen.queryAllByRole('alertdialog'),
      'a confirmation opened about another document is still on screen, now reading as though it were about this one',
    ).toHaveLength(0)

    // And if some other fix leaves it open — rebinding it to a captured
    // target, say — confirming it still must not take the document that
    // arrived. That is the invariant; the assertion above is one way of
    // meeting it.
    const stillOpen = screen.queryByRole('alertdialog')
    if (stillOpen !== null) {
      within(stillOpen)
        .getByRole('button', { name: /^delete$/i })
        .click()
      for (let i = 0; i < 100; i++) {
        await new Promise((r) => setTimeout(r, 50))
        if ((await listLocalDocuments(store)).length < 2) break
      }
      await act(async () => {})
    }

    const paths = (await listLocalDocuments(store)).map((row) => row.path)
    expect(
      paths,
      'the delete was confirmed on a dialog opened about another document, and it took this one — the dialog said its name and the action never looked',
    ).toContain('arrived-after')
  })
  it('a duplicate that fails for one document does not report under the one now on screen', async () => {
    const store = new HeldDuplicateIndex()
    await seedIdbDocument(store, {
      path: 'opened-about',
      name: OPENED_ABOUT,
      kind: 'spatial',
      makeDefault: true,
    })
    await seedIdbDocument(store, {
      path: 'arrived-after',
      name: ARRIVED_AFTER,
      kind: 'spatial',
    })

    render(<BrowserDocumentPage store={store} />)
    await waitFor(() =>
      expect(
        editorMounted,
        'the page is not wired yet; a switch now would be dropped',
      ).not.toBeNull(),
    )
    await waitFor(async () => {
      expect((await listLocalDocuments(store)).map((r) => r.path)).toHaveLength(2)
    })

    store.holdNextCreate = true
    const kebab = await screen.findByRole('button', { name: 'More actions' })
    fireEvent.pointerDown(kebab, { button: 0, ctrlKey: false })
    fireEvent.pointerUp(await screen.findByRole('menuitem', { name: /^duplicate$/i }))
    await store.attempted

    await act(async () => {
      navigateTo?.(documentPath(BROWSER_DEFAULT_SEGMENT, 'arrived-after'))
    })
    for (let i = 0; i < 100 && !document.body.textContent?.includes(ARRIVED_AFTER); i++) {
      await new Promise((r) => setTimeout(r, 50))
    }
    await act(async () => {})
    expect(
      document.body.textContent,
      'the page never switched, so the DUPLICATE case would pass without exercising anything',
    ).toContain(ARRIVED_AFTER)

    store.releaseFailure()
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 50))
      if (screen.queryByRole('alert') !== null) break
    }
    await act(async () => {})

    expect(
      screen.queryByText(/refused the write/i),
      'the duplicate that failed was the other document’s, and its error is on screen under this one — which has nothing wrong with it',
    ).toBeNull()
  })
  it('a body surface opened on one document does not stay open over the next', async () => {
    const store = new IdbDocumentIndex()
    await seedIdbDocument(store, {
      path: 'opened-about',
      name: OPENED_ABOUT,
      kind: 'spatial',
      makeDefault: true,
    })
    await seedIdbDocument(store, {
      path: 'arrived-after',
      name: ARRIVED_AFTER,
      kind: 'spatial',
    })

    render(<BrowserDocumentPage store={store} />)
    await waitFor(() =>
      expect(
        editorMounted,
        'the page is not wired yet; a switch now would be dropped',
      ).not.toBeNull(),
    )
    await waitFor(async () => {
      expect((await listLocalDocuments(store)).map((r) => r.path)).toHaveLength(2)
    })

    await act(async () => {
      openInEditor?.('n1', 'typed against a node in the first document')
    })
    expect(
      screen.queryByTestId('node-text-overlay'),
      'the surface did not open, so the switch below would prove nothing',
    ).not.toBeNull()

    await act(async () => {
      navigateTo?.(documentPath(BROWSER_DEFAULT_SEGMENT, 'arrived-after'))
    })
    // Longer than the other two cases here, and measured rather than guessed:
    // with the surface open this page also holds a CodeMirror instance, and
    // under the full suite the switch did not land inside their 5s. Still
    // well inside this file's 30s per-test budget, so a real failure lands on
    // an assertion rather than turning into a timeout that names nothing.
    for (let i = 0; i < 300 && !document.body.textContent?.includes(ARRIVED_AFTER); i++) {
      await new Promise((r) => setTimeout(r, 50))
    }
    await act(async () => {})
    expect(
      document.body.textContent,
      'the page never switched, so the BODY SURFACE case would pass without exercising anything',
    ).toContain(ARRIVED_AFTER)

    // It titles itself from the CURRENT document, so left open it reads as
    // "Editing <the one that arrived>" while holding the other one's node —
    // and its commit resolves that node in THIS canvas, does not find it,
    // and drops the write. Everything typed into it after this point would
    // go nowhere, with nothing said.
    expect(
      screen.queryByTestId('node-text-overlay'),
      'the body surface is still open over a document that does not hold the node it was opened on',
    ).toBeNull()
  })
})
