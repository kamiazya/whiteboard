/**
 * Markdown-canvas 導線 (real IndexedDB + real CodeMirror): create a markdown
 * note through the top bar's "New markdown note…" item, type into the real
 * source pane, and confirm the body survives a full page remount — the Loro
 * 'body' text container persisted through the SAME store the spatial
 * documents use. SpatialEditor is mocked (this suite's subject is the
 * kind-switch + persistence wiring, not gesture input), but MarkdownEditor
 * is REAL: CodeMirror's input path and Canvas 2D measurement are exactly
 * what jsdom cannot exercise.
 */

import { MARKDOWN_BODY_NODE_ID, writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, render as rtlRender, screen, waitFor } from '@testing-library/react'
import { Loro } from 'loro-crdt'
import type { ReactElement } from 'react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { IndexedDBStore, LOCAL_WORKSPACE_ID } from '../lib/browser-local-store.js'
import { LoroStore } from '../lib/loro-store.js'
import { clearWhiteboardDb } from '../test-utils/browser-local-document.js'
import { waitForMenuClosed } from '../test-utils/menu.js'
import '../index.css'
import { focusEditable } from '../test-utils/focus-editable.js'

function render(ui: ReactElement) {
  return rtlRender(
    // Pages fill their allotted height (h-full) — the app shell owns the
    // viewport in production, so tests supply the equivalent sized parent.
    <div style={{ height: '100vh' }}>
      <MemoryRouter initialEntries={['/']}>{ui}</MemoryRouter>
    </div>,
  )
}

let spatialMounts = 0

vi.mock('../components/spatial-editor/index.js', () => ({
  SpatialEditor: (_props: { canvas: SpatialCanvas }) => {
    spatialMounts += 1
    return <div data-testid="mock-spatial-editor" />
  },
}))

const { BrowserLocalDocumentPage } = await import('./BrowserLocalDocumentPage.js')

/**
 * Waits until the page reports the debounced save as landed.
 *
 * The save is debounced 500ms and then has to reach IndexedDB, so a fixed
 * sleep is a bet on machine speed — the timing-based assertion this repo
 * treats as a recurring flake shape, and what tipped these tests over under
 * load. `Saved` is the page's own report that the write completed, which is
 * the condition these tests actually depend on before tearing the page down.
 */
async function waitForSaved(): Promise<void> {
  await waitFor(() => expect(screen.getByRole('button', { name: 'Saved' })).toBeTruthy(), {
    timeout: 15_000,
  })
}

/**
 * Resolves the title input AFTER the markdown page that owns it has mounted.
 *
 * A spatial canvas carries the same properties bar, so `/title/i` matches on
 * BOTH pages. The switcher's menu is non-modal and closes without a focus
 * trap to sit through, which is fast enough that a bare query can resolve
 * against the OUTGOING page and hand back a node that is detached a moment
 * later. Typing then lands in the live input while the assertion reads the
 * dead one — indistinguishable, from the failure message, from "the
 * keystrokes were lost". Waiting for `.cm-content` pins the query to the
 * markdown page.
 */
async function findMarkdownTitleInput(): Promise<HTMLInputElement> {
  await waitFor(() => expect(document.querySelector('.cm-content')).not.toBeNull(), {
    timeout: 10_000,
  })
  return (await screen.findByRole('textbox', { name: /title/i })) as HTMLInputElement
}

/**
 * Asserts on the title input as it is NOW. Never hold a reference across an
 * action: the input remounts with the page, and a held node keeps reporting
 * the value it had when it was detached.
 */
async function expectTitleValue(expected: string): Promise<void> {
  await waitFor(
    () => {
      const live = screen.getByRole('textbox', { name: /title/i }) as HTMLInputElement
      expect(live.value).toBe(expected)
    },
    { timeout: 10_000 },
  )
}

describe('BrowserLocalDocumentPage markdown 導線 (real IndexedDB)', () => {
  beforeEach(async () => {
    await clearWhiteboardDb()
    spatialMounts = 0
  })

  afterEach(() => {
    cleanup()
  })

  it('New markdown note… opens the markdown editor; the typed body survives a remount', async () => {
    const store = new IndexedDBStore()
    const first = render(<BrowserLocalDocumentPage store={store} />)

    // Fresh DB boots into a spatial canvas.
    await screen.findByTestId('mock-spatial-editor')

    // Open the switcher dropdown and create a markdown note.
    const switcher = await screen.findByRole(
      'button',
      { name: /^Workspace:/i },
      { timeout: 10_000 },
    )
    await userEvent.click(switcher)
    const newMarkdown = await screen.findByTestId('new-markdown-menu-item')
    await userEvent.click(newMarkdown)

    // The markdown editor (real CodeMirror) replaces the spatial editor.
    const editable = await waitFor(() => {
      const el = document.querySelector('[contenteditable="true"]')
      expect(el).not.toBeNull()
      return el as HTMLElement
    })
    expect(screen.queryByTestId('mock-spatial-editor')).toBeNull()

    // Typing starts the moment the editor appears, with NO click and NO
    // settling wait: a fresh markdown note must be focused for typing
    // immediately, and the dropdown's close-time focus return must never
    // steal keystrokes mid-word (the bug shipped as "type a sentence,
    // only the first three characters persist").
    //
    // The wait checks activeElement IS the CodeMirror contentDOM (.cm-content,
    // same element as `editable`), not merely contained by .cm-editor — that
    // exact identity is what real keyboard-event delivery depends on, and a
    // looser containment check can pass while focus still sits on some other
    // in-flight descendant (e.g. mid-mount) and races the first keystrokes.
    // Wider than the 10s the rest of this file carries, because this one waits
    // on mount PLUS autofocus against a real browser and real IndexedDB, and
    // the testing-library default is 1s. Under a full browser-project run that
    // expires with focus still on <body>, which reads as "autofocus is broken"
    // when it only means "autofocus had not happened yet" — measured failing
    // twice at ~11s while the same test costs 1.3s with its file alone. The
    // guarantee under test is that focus arrives before typing, not that it
    // arrives within any particular budget.
    await waitFor(
      () => {
        expect(document.activeElement).toBe(editable)
      },
      { timeout: 30_000 },
    )
    await userEvent.keyboard('# Persisted note')
    await waitFor(() => {
      expect(document.querySelector('.cm-content')?.textContent).toBe('# Persisted note')
    })

    await waitForSaved()
    first.unmount()

    // A fresh page against the same store reopens the markdown note with
    // its body restored from the Loro 'body' container.
    render(<BrowserLocalDocumentPage store={store} />)
    await waitFor(() => {
      const content = document.querySelector('.cm-content')
      expect(content?.textContent).toContain('# Persisted note')
    })
    expect(screen.queryByTestId('mock-spatial-editor')).toBeNull()
  })

  it('a markdown canvas has no display-settings gear — edge routing is spatial-only', async () => {
    const store = new IndexedDBStore()
    render(<BrowserLocalDocumentPage store={store} />)

    // Fresh DB boots into a spatial canvas: the gear is offered there.
    await screen.findByTestId('mock-spatial-editor')
    await waitFor(() => {
      expect(document.querySelector('[data-testid="canvas-settings-button"]')).not.toBeNull()
    })

    const switcher = await screen.findByRole(
      'button',
      { name: /^Workspace:/i },
      { timeout: 10_000 },
    )
    await userEvent.click(switcher)
    await userEvent.click(await screen.findByTestId('new-markdown-menu-item'))
    await waitFor(() => {
      expect(document.querySelector('[contenteditable="true"]')).not.toBeNull()
    })

    // Edge routing has no meaning for a document with no spatial scene —
    // the gear must not carry over; the rest of the canvas row does.
    expect(document.querySelector('[data-testid="canvas-settings-button"]')).toBeNull()
    expect(document.querySelector('[data-testid="save-status-chip"]')).toBeTruthy()
  })

  it('the title survives a remount and renames the canvas in the switcher', async () => {
    const store = new IndexedDBStore()
    const first = render(<BrowserLocalDocumentPage store={store} />)

    await screen.findByTestId('mock-spatial-editor')
    const switcher = await screen.findByRole(
      'button',
      { name: /^Workspace:/i },
      { timeout: 10_000 },
    )
    await userEvent.click(switcher)
    await userEvent.click(await screen.findByTestId('new-markdown-menu-item'))

    const title = await findMarkdownTitleInput()
    // The markdown arm of the merged row: the title lives INSIDE the
    // workspace header (one chrome row), not a detached strip below it.
    expect(title.closest('header')).toBeTruthy()
    await userEvent.click(title)
    await userEvent.keyboard('リリース計画')
    await expectTitleValue('リリース計画')

    // The title IS the canvas name — one value in the snapshot row, observed
    // in the switcher's LIST since its trigger names the workspace rather
    // than the canvas.
    await userEvent.click(await screen.findByRole('button', { name: /^Workspace:/i }))
    // Scoped to the menu item: the title INPUT holds the same string, so a
    // bare text query matches both and cannot tell them apart.
    await screen.findByRole('menuitem', { name: /リリース計画/ }, { timeout: 10_000 })
    await userEvent.keyboard('{Escape}')

    await waitForSaved()
    first.unmount()

    render(<BrowserLocalDocumentPage store={store} />)
    await waitFor(() => {
      const restored = screen.getByRole('textbox', { name: /title/i }) as HTMLInputElement
      expect(restored.value).toBe('リリース計画')
    })

    // And it came back from the WORKSPACE, not from a second copy in the
    // content: the document a rename touches holds no `title` facet at all
    // (ADR-0009 decision 2). Without this the test passes on a document that
    // stores the name twice, which is the state it exists to rule out.
    // By kind, not by index: the workspace still holds the initial spatial
    // canvas this flow started from.
    const entry = (await store.listDocuments()).find((row) => row.kind === 'markdown')
    expect(entry?.name).toBe('リリース計画')
    const loaded = await new LoroStore().load(entry?.documentId ?? '')
    expect(loaded.kind).toBe('ok')
    if (loaded.kind === 'ok') {
      const doc = new Loro()
      doc.import(loaded.snapshot)
      for (const delta of loaded.deltas ?? []) doc.import(delta)
      expect(doc.getMap('core').get('title')).toBeUndefined()
    }
  })

  it('keeps the body when core facets are written, and vice versa', async () => {
    const store = new IndexedDBStore()
    const first = render(<BrowserLocalDocumentPage store={store} />)

    await screen.findByTestId('mock-spatial-editor')
    const switcher = await screen.findByRole(
      'button',
      { name: /^Workspace:/i },
      { timeout: 10_000 },
    )
    await userEvent.click(switcher)
    await userEvent.click(await screen.findByTestId('new-markdown-menu-item'))

    await waitFor(() => {
      expect(document.querySelector('[contenteditable="true"]')).not.toBeNull()
    })
    // Click-focus (matching every other CodeMirror typing suite in this
    // repo) rather than relying on autofocus: this test's subject is
    // body/facet independence, not the fresh-note autofocus guarantee that
    // test 1 above already pins (see its focus-wait comment for why exact
    // contentDOM identity is required).
    const resolveEditable = () => document.querySelector('[contenteditable="true"]')
    await focusEditable(resolveEditable)
    // Re-resolved, not the retained reference: a contentDOM swap between the
    // grab and here would leave focusEditable succeeding on the live node
    // while this assertion compares against the dead one.
    await waitFor(
      () => {
        expect(document.activeElement).toBe(resolveEditable())
      },
      { timeout: 10_000 },
    )
    await userEvent.keyboard('body first')
    await waitFor(() => {
      expect(document.querySelector('.cm-content')?.textContent).toBe('body first')
    })

    // Body and facets are containers of ONE document saved as a whole
    // snapshot; writing facets after the body must not export a document
    // that has lost the body (and the reverse must hold too).
    const title = screen.getByRole('textbox', { name: /title/i })
    await userEvent.click(title)
    await userEvent.keyboard('Titled')

    await waitForSaved()
    first.unmount()

    render(<BrowserLocalDocumentPage store={store} />)
    await waitFor(() => {
      expect(document.querySelector('.cm-content')?.textContent).toContain('body first')
    })
    expect((screen.getByRole('textbox', { name: /title/i }) as HTMLInputElement).value).toBe(
      'Titled',
    )
  })

  it('flushes a title edit that is still debounced when the page goes away', async () => {
    const store = new IndexedDBStore()
    const first = render(<BrowserLocalDocumentPage store={store} />)

    await screen.findByTestId('mock-spatial-editor')
    const switcher = await screen.findByRole(
      'button',
      { name: /^Workspace:/i },
      { timeout: 10_000 },
    )
    await userEvent.click(switcher)
    await userEvent.click(await screen.findByTestId('new-markdown-menu-item'))

    const title = await findMarkdownTitleInput()
    await userEvent.click(title)
    await userEvent.keyboard('Fast switch')
    await expectTitleValue('Fast switch')

    // Unmount immediately after typing. The name goes through `renameDocument`,
    // which flushes rather than debouncing — but the markdown document's own
    // save is still pending, and an unmount that tore the page down before
    // the rename landed would lose the title with it.
    first.unmount()

    render(<BrowserLocalDocumentPage store={store} />)
    // The only assertion in this file gated on a save that had NOT landed
    // before the unmount — every other reload here calls waitForSaved()
    // first. That makes this reload wait for the flush to finish rather than
    // race it, which is the behaviour under test but also strictly slower
    // than an unordered read, and testing-library's 1s default is not a
    // budget for a real IndexedDB write plus a read on a loaded CI runner.
    await waitFor(
      () => {
        const restored = screen.getByRole('textbox', { name: /title/i }) as HTMLInputElement
        expect(restored.value).toBe('Fast switch')
      },
      { timeout: 10_000 },
    )
  })

  it('a spatial canvas gets the same properties bar, and its title round-trips', async () => {
    const store = new IndexedDBStore()
    await store.setDefaultDocumentId('0JNRVY147ADGKPSWZ258BEHMQT')
    await store.save({
      documentId: '0JNRVY147ADGKPSWZ258BEHMQT',
      workspaceId: 'local',
      path: 'diagram-a',
      name: 'Diagram A',
      updatedAt: '2026-05-24T00:00:00.000Z',
      kind: 'spatial' as const,
    })
    const first = render(<BrowserLocalDocumentPage store={store} />)
    await screen.findByTestId('mock-spatial-editor')

    // Naming is format-agnostic (ADR-0009 decision 2), so a spatial canvas
    // carries the same title box — reading and writing the same snapshot row
    // the markdown one does.
    const title = await screen.findByRole('textbox', { name: /title/i }, { timeout: 10_000 })
    expect((title as HTMLInputElement).value).toBe('Diagram A')
    // But NOT the facets beside it: a facet is OKF frontmatter and JSON
    // Canvas has nowhere to put one (decision 3). The disclosure used to be
    // hidden while the page went on writing through it.
    expect(screen.queryByRole('button', { name: /properties/i })).toBeNull()

    // clear(), not a select-all chord: the browser's select-all is Cmd+A on
    // macOS and Ctrl+A elsewhere, so `{Control>}a{/Control}` selects nothing
    // on a Mac and the new title appends to the old one ("Diagram
    // AArchitecture map"). clear() drives the field's own selection API and
    // means the same thing on every platform.
    await userEvent.click(title)
    await userEvent.clear(title)
    await userEvent.keyboard('Architecture map')
    await userEvent.click(await screen.findByRole('button', { name: /^Workspace:/i }))
    await screen.findByRole('menuitem', { name: /Architecture map/ }, { timeout: 10_000 })
    await userEvent.keyboard('{Escape}')

    await waitForSaved()
    first.unmount()

    render(<BrowserLocalDocumentPage store={store} />)
    await waitFor(
      () => {
        const restored = screen.getByRole('textbox', { name: /title/i }) as HTMLInputElement
        expect(restored.value).toBe('Architecture map')
      },
      { timeout: 10_000 },
    )
  })

  it('spatial documents still open the spatial editor after a markdown note exists', async () => {
    const store = new IndexedDBStore()
    // Distinctly-named spatial canvas so the round trip back to it is
    // unambiguous (the fresh markdown note is also 'untitled').
    await store.setDefaultDocumentId('0JNRVY147ADGKPSWZ258BEHMQT')
    await store.save({
      documentId: '0JNRVY147ADGKPSWZ258BEHMQT',
      workspaceId: 'local',
      path: 'diagram-a-2',
      name: 'Diagram A',
      updatedAt: '2026-05-24T00:00:00.000Z',
      kind: 'spatial' as const,
    })
    render(<BrowserLocalDocumentPage store={store} />)
    await screen.findByTestId('mock-spatial-editor')

    const switcher = await screen.findByRole(
      'button',
      { name: /^Workspace:/i },
      { timeout: 10_000 },
    )
    await userEvent.click(switcher)
    await userEvent.click(await screen.findByTestId('new-markdown-menu-item'))
    await waitFor(() => {
      expect(document.querySelector('[contenteditable="true"]')).not.toBeNull()
    })

    // Switch back to the original spatial canvas via the switcher list.
    const before = spatialMounts
    const switcher2 = await screen.findByRole(
      'button',
      { name: /^Workspace:/i },
      { timeout: 10_000 },
    )
    // Removing this wait no longer fails the file in isolation — the race it
    // guards only opens up once the whole browser project is in flight. Keep
    // it: an isolated green says nothing about the run that actually flakes.
    await waitForMenuClosed()
    await userEvent.click(switcher2)
    await userEvent.click(await screen.findByText('Diagram A', undefined, { timeout: 10_000 }))

    await waitFor(() => {
      expect(screen.getByTestId('mock-spatial-editor')).toBeInTheDocument()
    })
    expect(spatialMounts).toBeGreaterThan(before)
  })

  // The picker is only useful if the PAGE hands it the document list it
  // already holds. Nothing else fails when that one prop stops being passed:
  // `linkTargets` is optional, so the verb quietly degrades to its bracket
  // wrap while typecheck and every component test stay green.
  it("offers the page's own documents to the link picker", async () => {
    const store = new IndexedDBStore()
    await store.save({
      documentId: '0SWZ258BEHMQTX0369CFJNRVY1',
      workspaceId: 'local',
      path: 'neighbour-note',
      name: 'Neighbour note',
      updatedAt: '2026-05-24T00:00:00.000Z',
      kind: 'markdown' as const,
    })
    const HERE = '01BX5ZZKBKACTAV9WEVGEMMVAA'
    await store.save({
      documentId: HERE,
      workspaceId: LOCAL_WORKSPACE_ID,
      path: 'this-note',
      name: 'This note',
      updatedAt: '2026-05-24T00:00:01.000Z',
      kind: 'markdown' as const,
    })
    await store.setDefaultDocumentId(HERE)
    render(<BrowserLocalDocumentPage store={store} />)

    const editable = await waitFor(
      () => {
        const el = document.querySelector('[contenteditable="true"]')
        expect(el).not.toBeNull()
        return el as HTMLElement
      },
      { timeout: 10_000 },
    )
    editable.focus()

    await userEvent.click(await screen.findByRole('button', { name: 'Editing actions' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Link' }))

    const picker = await screen.findByTestId('link-picker')
    expect(picker.textContent).toContain('Neighbour note')
  })

  it('a [[Name]] wikiLink resolves against the canvas list and clicking it opens that note', async () => {
    const TARGET_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
    const SOURCE_ID = '01BX5ZZKBKACTAV9WEVGEMMVRZ'
    const store = new IndexedDBStore()
    await store.save({
      documentId: TARGET_ID,
      workspaceId: LOCAL_WORKSPACE_ID,
      path: 'target-note',
      name: 'Target note',
      updatedAt: '2026-05-24T00:00:00.000Z',
      kind: 'markdown' as const,
    })
    await store.save({
      documentId: SOURCE_ID,
      workspaceId: LOCAL_WORKSPACE_ID,
      path: 'source-note',
      name: 'Source note',
      updatedAt: '2026-05-24T00:00:01.000Z',
      kind: 'markdown' as const,
    })
    await store.setDefaultDocumentId(SOURCE_ID)
    // The router's pathname is the navigation contract under test; the page
    // itself shows no raw id anywhere a query could reach.
    function LocationProbe() {
      const location = useLocation()
      return <div data-testid="location-probe">{location.pathname}</div>
    }
    render(
      <>
        <BrowserLocalDocumentPage store={store} />
        <LocationProbe />
      </>,
    )

    const editable = await waitFor(
      () => {
        const el = document.querySelector('[contenteditable="true"]')
        expect(el).not.toBeNull()
        return el as HTMLElement
      },
      { timeout: 10_000 },
    )
    // focus() instead of click(): the page has TWO role=textbox elements
    // (the title input and CodeMirror's content), so a click locator on the
    // contenteditable is ambiguous under playwright's strict mode.
    editable.focus()
    // `[[` doubled: userEvent.keyboard's escape for a literal `[`.
    await userEvent.keyboard('See [[[[Target note]] here.')

    // The debounced preview resolves the alias into an anchor carrying the
    // target's canvas id.
    const anchor = await waitFor(
      () => {
        const el = document.querySelector(`a[href="${TARGET_ID}"]`)
        expect(el).not.toBeNull()
        return el as HTMLElement
      },
      { timeout: 10_000 },
    )
    await userEvent.click(anchor)

    // Navigation lands on the target note's route.
    await waitFor(
      () => {
        // The link names the target by ID (so it survives a move); the address
        // bar names it by PATH. Following one crosses that boundary.
        expect(screen.getByTestId('location-probe').textContent).toBe('/local/target-note')
      },
      { timeout: 10_000 },
    )
  })

  it("a block ![[embed]] renders the target note's body inline in the preview", async () => {
    const TARGET_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
    const SOURCE_ID = '01BX5ZZKBKACTAV9WEVGEMMVRZ'
    const store = new IndexedDBStore()
    await store.save({
      documentId: TARGET_ID,
      workspaceId: LOCAL_WORKSPACE_ID,
      path: 'embed-target',
      name: 'Embed target',
      updatedAt: '2026-05-24T00:00:00.000Z',
      kind: 'markdown' as const,
    })
    await store.save({
      documentId: SOURCE_ID,
      workspaceId: LOCAL_WORKSPACE_ID,
      path: 'embed-source',
      name: 'Embed source',
      updatedAt: '2026-05-24T00:00:01.000Z',
      kind: 'markdown' as const,
    })
    // Seed the target's Loro body through the same store the page loads from.
    const targetDoc = new Loro()
    targetDoc.getText('body').insert(0, 'unmistakable embedded body text')
    await new LoroStore().save(TARGET_ID, targetDoc.export({ mode: 'snapshot' }))
    await store.setDefaultDocumentId(SOURCE_ID)
    render(<BrowserLocalDocumentPage store={store} />)

    const editable = await waitFor(
      () => {
        const el = document.querySelector('[contenteditable="true"]')
        expect(el).not.toBeNull()
        return el as HTMLElement
      },
      { timeout: 10_000 },
    )
    editable.focus()
    // Trailing keystrokes AFTER the reference completes are the regression
    // surface: each one re-runs the embed-content effect while the load is
    // in flight, and a per-effect cancellation dropped the result with
    // nothing left to re-fire it (the stuck-placeholder bug).
    // Blank line after the reference: a single newline is a markdown SOFT
    // break, which would fold the trailing text into the embed's paragraph
    // and turn it into an INLINE run instead of a block embed.
    await userEvent.keyboard(`![[[[${TARGET_ID}]]{Enter}{Enter}and more typing`)

    // The preview loads the target body asynchronously and lays it out
    // inline through the render pipeline's embed seam.
    await waitFor(
      () => {
        const preview = document.querySelector('[data-testid="markdown-preview-pane"]')
        expect(preview?.textContent).toContain('unmistakable embedded body text')
      },
      { timeout: 10_000 },
    )
  })

  describe('a body written the pre-unification way', () => {
    // `wb_document_set` used to store a body as an `okf-body` TEXT NODE
    // rather than the `body` text container CodeMirror binds to. Both sides
    // now write the container, but documents in the old shape are already in
    // stores — and only a real browser can show what CodeMirror actually
    // displays for one, which is the half a hook test cannot reach.
    const LEGACY_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
    const LEGACY_BODY = 'body stored as an okf-body node'

    async function seedLegacyNote(store: IndexedDBStore, name: string): Promise<void> {
      await store.save({
        documentId: LEGACY_ID,
        workspaceId: LOCAL_WORKSPACE_ID,
        path: 'legacy-note',
        name,
        updatedAt: '2026-05-24T00:00:00.000Z',
        kind: 'markdown' as const,
      })
      const doc = new Loro()
      writeSpatialCanvas(doc, {
        nodes: [
          {
            id: MARKDOWN_BODY_NODE_ID,
            type: 'text',
            x: 0,
            y: 0,
            width: 600,
            height: 400,
            text: LEGACY_BODY,
          },
        ],
        edges: [],
      })
      doc.commit()
      await new LoroStore().save(LEGACY_ID, doc.export({ mode: 'snapshot' }))
    }

    it('stays editable without losing the body it opened with', async () => {
      // This needs a real browser for the CRDT binding. `LoroSyncPlugin`
      // syncs the `body` CONTAINER into CodeMirror on mount, overwriting the
      // `value` prop — so for a document whose prose is still in a node, the
      // editor settles on the placeholder while the preview shows the text,
      // and the next edit saves over the original.
      //
      // Asserted AFTER a full edit/save/remount cycle rather than on first
      // paint: the value prop is briefly visible before the binding takes
      // over, so an assertion at mount can pass on a frame that is about to
      // be replaced. By the reopen there is no path that puts the old body
      // on screen unless it really was converted and persisted.
      const store = new IndexedDBStore()
      await seedLegacyNote(store, 'Legacy note')
      await store.setDefaultDocumentId(LEGACY_ID)
      const first = render(<BrowserLocalDocumentPage store={store} />)

      const editable = await waitFor(
        () => {
          const el = document.querySelector('.cm-content')
          expect(el).not.toBeNull()
          return el as HTMLElement
        },
        { timeout: 10_000 },
      )
      editable.focus()
      await userEvent.keyboard('{Control>}{End}{/Control}{Enter}and an appended line')
      await waitFor(() => {
        expect(document.querySelector('.cm-content')?.textContent).toContain('and an appended line')
      })

      await waitForSaved()
      first.unmount()

      render(<BrowserLocalDocumentPage store={store} />)
      await waitFor(
        () => {
          const text = document.querySelector('.cm-content')?.textContent
          expect(text).toContain(LEGACY_BODY)
          expect(text).toContain('and an appended line')
        },
        { timeout: 10_000 },
      )
    })

    it('renders as an ![[embed]] target', async () => {
      const SOURCE_ID = '01BX5ZZKBKACTAV9WEVGEMMVRZ'
      const store = new IndexedDBStore()
      await seedLegacyNote(store, 'Legacy embed target')
      await store.save({
        documentId: SOURCE_ID,
        workspaceId: LOCAL_WORKSPACE_ID,
        path: 'embed-source',
        name: 'Embed source',
        updatedAt: '2026-05-24T00:00:01.000Z',
        kind: 'markdown' as const,
      })
      await store.setDefaultDocumentId(SOURCE_ID)
      render(<BrowserLocalDocumentPage store={store} />)

      const editable = await waitFor(
        () => {
          const el = document.querySelector('[contenteditable="true"]')
          expect(el).not.toBeNull()
          return el as HTMLElement
        },
        { timeout: 10_000 },
      )
      editable.focus()
      await userEvent.keyboard(`![[[[${LEGACY_ID}]]{Enter}{Enter}trailing`)

      await waitFor(
        () => {
          const preview = document.querySelector('[data-testid="markdown-preview-pane"]')
          expect(preview?.textContent).toContain(LEGACY_BODY)
        },
        { timeout: 10_000 },
      )
    })
  })
})
