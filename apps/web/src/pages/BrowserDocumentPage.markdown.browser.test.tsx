import { FoldingBrowserIndex } from '../lib/folding-browser-index.js'
import { IdbDocumentIndex } from '../lib/idb-document-index.js'
import { listLocalDocuments } from '../lib/local-document-summary.js'
import { seedIdbDocument } from '../test-utils/seed-idb-document.js'
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
import { LoroStore } from '../lib/loro-store.js'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import '../index.css'
import { focusEditable } from '../test-utils/focus-editable.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'

claimIsolatedWhiteboardDb('browserdocumentpage-markdown')

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

const { BrowserDocumentPage } = await import('./BrowserDocumentPage.js')

/**
 * Waits until a debounced save has actually LANDED for this document.
 *
 * Not `getByRole('button', { name: 'Saved' })`. A document that has never
 * been written is already `Saved` — correct for a reader, and useless as
 * proof that a write completed. That wait matched the state the page was
 * already in, so these tests navigated away with the write still pending and
 * read the loss later as lost keystrokes: `expected '# ' to contain
 * '# From the list'` after reopening, with a 15s budget the write never
 * needed because it was never going to happen.
 *
 * `data-last-saved-at` is absent until a write lands, so requiring it
 * together with a settled `saved` state is a TRANSITION rather than a label.
 */
async function waitForSaved(): Promise<void> {
  await waitFor(
    () => {
      const chip = document.querySelector('[data-testid="save-status-chip"]')
      expect(chip?.getAttribute('data-save-state')).toBe('saved')
      expect(chip?.getAttribute('data-last-saved-at')).toBeTruthy()
    },
    { timeout: 15_000 },
  )
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

describe('BrowserDocumentPage markdown 導線 (real IndexedDB)', () => {
  beforeEach(async () => {
    await clearWhiteboardDb()
    spatialMounts = 0
  })

  afterEach(() => {
    cleanup()
  })

  // Documents are created in the document browser and opened by navigating
  // here, so these suites seed the document rather than driving a create
  // control this page no longer has.
  it('a markdown document opens the markdown editor; the typed body survives a remount', async () => {
    const store = new IdbDocumentIndex()
    await seedIdbDocument(store, { path: 'note', kind: 'markdown', makeDefault: true })
    const first = render(<BrowserDocumentPage store={store} />)

    // The markdown editor (real CodeMirror) is what mounts for this kind.
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
    render(<BrowserDocumentPage store={store} />)
    await waitFor(() => {
      const content = document.querySelector('.cm-content')
      expect(content?.textContent).toContain('# Persisted note')
    })
    expect(screen.queryByTestId('mock-spatial-editor')).toBeNull()
  })

  /**
   * The OKF core facets a person edits, through real IndexedDB. jsdom already
   * covers which value the component emits; what only a browser can answer is
   * whether the emitted value reaches the Loro `core` bucket and comes back
   * after the page is torn down and rebuilt.
   */
  it('the OKF summary and describes fields survive a remount', async () => {
    const store = new IdbDocumentIndex()
    await seedIdbDocument(store, { path: 'note', kind: 'markdown', makeDefault: true })
    const first = render(<BrowserDocumentPage store={store} />)
    await findMarkdownTitleInput()

    await userEvent.click(screen.getByRole('button', { name: /properties/i }))
    // Queried inside each step rather than held: the properties bar remounts
    // with the page, and a held input reports the value it had when detached.
    await userEvent.fill(
      screen.getByRole('textbox', { name: /summary/i }),
      'Completed orders across all channels.',
    )
    await userEvent.fill(
      screen.getByRole('textbox', { name: /describes/i }),
      'https://example.com/orders',
    )

    await waitForSaved()
    first.unmount()

    render(<BrowserDocumentPage store={store} />)
    await findMarkdownTitleInput()
    await userEvent.click(screen.getByRole('button', { name: /properties/i }))
    await waitFor(
      () => {
        const summary = screen.getByRole('textbox', { name: /summary/i }) as HTMLInputElement
        const describes = screen.getByRole('textbox', { name: /describes/i }) as HTMLInputElement
        expect(summary.value).toBe('Completed orders across all channels.')
        expect(describes.value).toBe('https://example.com/orders')
      },
      { timeout: 10_000 },
    )
  })

  it('a markdown canvas has no display-settings gear — edge routing is spatial-only', async () => {
    const spatialStore = new IdbDocumentIndex()
    const spatial = render(<BrowserDocumentPage store={spatialStore} />)

    // A spatial canvas is where the gear is offered.
    await screen.findByTestId('mock-spatial-editor')
    await waitFor(() => {
      expect(document.querySelector('[data-testid="canvas-settings-button"]')).not.toBeNull()
    })
    spatial.unmount()

    const store = new IdbDocumentIndex()
    await seedIdbDocument(store, { path: 'note', kind: 'markdown', makeDefault: true })
    render(<BrowserDocumentPage store={store} />)
    await waitFor(() => {
      expect(document.querySelector('[contenteditable="true"]')).not.toBeNull()
    })

    // Edge routing has no meaning for a document with no spatial scene —
    // the gear must not carry over; the rest of the canvas row does.
    expect(document.querySelector('[data-testid="canvas-settings-button"]')).toBeNull()
    expect(document.querySelector('[data-testid="save-status-chip"]')).toBeTruthy()
  })

  it("the title survives a remount and is the document's one name", async () => {
    const store = new IdbDocumentIndex()
    await seedIdbDocument(store, { path: 'note', kind: 'markdown', makeDefault: true })
    const first = render(<BrowserDocumentPage store={store} />)

    const title = await findMarkdownTitleInput()
    // The markdown arm of the merged row: the title lives INSIDE the
    // workspace header (one chrome row), not a detached strip below it.
    expect(title.closest('header')).toBeTruthy()
    await userEvent.click(title)
    // Non-ASCII goes through fill, not per-key synthesis: characters with no
    // keycode are synthesized out of band and drop under load (see
    // browser-test-keyboard-ascii.test.ts).
    await userEvent.fill(title, 'リリース計画')
    await expectTitleValue('リリース計画')

    // The title IS the document's name — one value in the snapshot row,
    // observed in the page's own heading landmark rather than in the title
    // input that is being typed into.
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('リリース計画'),
    )

    await waitForSaved()
    first.unmount()

    render(<BrowserDocumentPage store={store} />)
    await waitFor(() => {
      const restored = screen.getByRole('textbox', { name: /title/i }) as HTMLInputElement
      expect(restored.value).toBe('リリース計画')
    })

    // And it came back from the WORKSPACE, not from a second copy in the
    // content: the document a rename touches holds no `title` facet at all
    // (ADR-0009 decision 2). Without this the test passes on a document that
    // stores the name twice, which is the state it exists to rule out.
    const entry = (await listLocalDocuments(store)).find((row) => row.kind === 'markdown')
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
    const store = new IdbDocumentIndex()
    await seedIdbDocument(store, { path: 'note', kind: 'markdown', makeDefault: true })
    const first = render(<BrowserDocumentPage store={store} />)

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

    render(<BrowserDocumentPage store={store} />)
    await waitFor(() => {
      expect(document.querySelector('.cm-content')?.textContent).toContain('body first')
    })
    expect((screen.getByRole('textbox', { name: /title/i }) as HTMLInputElement).value).toBe(
      'Titled',
    )
  })

  it('flushes a title edit that is still debounced when the page goes away', async () => {
    const store = new IdbDocumentIndex()
    await seedIdbDocument(store, { path: 'note', kind: 'markdown', makeDefault: true })
    const first = render(<BrowserDocumentPage store={store} />)

    const title = await findMarkdownTitleInput()
    await userEvent.click(title)
    await userEvent.keyboard('Fast switch')
    await expectTitleValue('Fast switch')

    // Unmount immediately after typing. The name goes through `renameDocument`,
    // which flushes rather than debouncing — but the markdown document's own
    // save is still pending, and an unmount that tore the page down before
    // the rename landed would lose the title with it.
    first.unmount()

    render(<BrowserDocumentPage store={store} />)
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
    const store = new IdbDocumentIndex()
    await seedIdbDocument(store, {
      path: 'diagram-a',
      name: 'Diagram A',
      kind: 'spatial',
      makeDefault: true,
    })
    const first = render(<BrowserDocumentPage store={store} />)
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
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Architecture map'),
    )

    await waitForSaved()
    first.unmount()

    render(<BrowserDocumentPage store={store} />)
    await waitFor(
      () => {
        const restored = screen.getByRole('textbox', { name: /title/i }) as HTMLInputElement
        expect(restored.value).toBe('Architecture map')
      },
      { timeout: 10_000 },
    )
  })

  it('spatial documents still open the spatial editor after a markdown note exists', async () => {
    const store = new IdbDocumentIndex()
    // Distinctly-named spatial canvas so the round trip back to it is
    // unambiguous (the fresh markdown note is also 'untitled').
    await seedIdbDocument(store, {
      path: 'diagram-a-2',
      name: 'Diagram A',
      kind: 'spatial',
      makeDefault: true,
    })
    await seedIdbDocument(store, { path: 'a-note', kind: 'markdown', makeDefault: true })
    const note = render(<BrowserDocumentPage store={store} />)
    await waitFor(() => {
      expect(document.querySelector('[contenteditable="true"]')).not.toBeNull()
    })
    note.unmount()

    // Opening the spatial document again — the way arriving from the document
    // browser does — must still mount the spatial editor, not carry the
    // markdown one over.
    const before = spatialMounts
    render(<BrowserDocumentPage store={store} initialPath="diagram-a-2" />)

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
    const store = new IdbDocumentIndex()
    await seedIdbDocument(store, {
      path: 'neighbour-note',
      name: 'Neighbour note',
      kind: 'markdown',
    })
    await seedIdbDocument(store, {
      path: 'this-note',
      name: 'This note',
      kind: 'markdown',
      makeDefault: true,
    })
    render(<BrowserDocumentPage store={store} />)

    // focusEditable rather than focus() on the node resolved a moment ago:
    // under load the contentDOM can arrive late or be swapped, and focus()
    // on a detached element is a spec'd no-op that no wait here would
    // recover from — the keystrokes simply go nowhere. It also answers the
    // reason a click is wrong on this page: there are TWO role=textbox
    // elements (the title input and CodeMirror's content), so a click
    // locator on the contenteditable is ambiguous under strict mode.
    await focusEditable(() => document.querySelector('[contenteditable="true"]'))

    await userEvent.click(await screen.findByRole('button', { name: 'Editing actions' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Link' }))

    const picker = await screen.findByTestId('link-picker')
    expect(picker.textContent).toContain('Neighbour note')
  })

  it('a [[path]] wikiLink resolves, shows the display name, and opens that note', async () => {
    const store = new IdbDocumentIndex()
    const TARGET_ID = await seedIdbDocument(store, {
      path: 'target-note',
      name: 'Target note',
      kind: 'markdown',
    })
    await seedIdbDocument(store, {
      path: 'source-note',
      name: 'Source note',
      kind: 'markdown',
      makeDefault: true,
    })
    // The router's pathname is the navigation contract under test; the page
    // itself shows no raw id anywhere a query could reach.
    function LocationProbe() {
      const location = useLocation()
      return <div data-testid="location-probe">{location.pathname}</div>
    }
    render(
      <>
        <BrowserDocumentPage store={store} />
        <LocationProbe />
      </>,
    )

    // focusEditable rather than focus() on the node resolved a moment ago:
    // under load the contentDOM can arrive late or be swapped, and focus()
    // on a detached element is a spec'd no-op that no wait here would
    // recover from — the keystrokes simply go nowhere. It also answers the
    // reason a click is wrong on this page: there are TWO role=textbox
    // elements (the title input and CodeMirror's content), so a click
    // locator on the contenteditable is ambiguous under strict mode.
    await focusEditable(() => document.querySelector('[contenteditable="true"]'))
    // `[[` doubled: userEvent.keyboard's escape for a literal `[`. The
    // PATH is the written form; the display name appears at render time.
    await userEvent.keyboard('See [[[[target-note]] here.')

    // The debounced preview resolves the alias into an anchor carrying the
    // target's document id, labeled with the CURRENT display name.
    const anchor = await waitFor(
      () => {
        const el = document.querySelector(`a[href="${TARGET_ID}"]`)
        expect(el).not.toBeNull()
        expect((el as HTMLElement).textContent).toBe('Target note')
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
        expect(screen.getByTestId('location-probe').textContent).toBe('/w/default/d/target-note')
      },
      { timeout: 10_000 },
    )
  })

  it("a block ![[embed]] renders the target note's body inline in the preview", async () => {
    const store = new IdbDocumentIndex()
    const TARGET_ID = await seedIdbDocument(store, {
      path: 'embed-target',
      name: 'Embed target',
      kind: 'markdown',
    })
    await seedIdbDocument(store, {
      path: 'embed-source',
      name: 'Embed source',
      kind: 'markdown',
      makeDefault: true,
    })
    // Seed the target's Loro body through the same store the page loads from.
    const targetDoc = new Loro()
    targetDoc.getText('body').insert(0, 'unmistakable embedded body text')
    await new LoroStore().save(TARGET_ID, targetDoc.export({ mode: 'snapshot' }))
    render(<BrowserDocumentPage store={store} />)

    // focusEditable rather than focus() on the node resolved a moment ago:
    // under load the contentDOM can arrive late or be swapped, and focus()
    // on a detached element is a spec'd no-op that no wait here would
    // recover from — the keystrokes simply go nowhere. It also answers the
    // reason a click is wrong on this page: there are TWO role=textbox
    // elements (the title input and CodeMirror's content), so a click
    // locator on the contenteditable is ambiguous under strict mode.
    await focusEditable(() => document.querySelector('[contenteditable="true"]'))
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
    const LEGACY_BODY = 'body stored as an okf-body node'

    async function seedLegacyNote(store: IdbDocumentIndex, name: string): Promise<string> {
      const legacyId = await seedIdbDocument(store, {
        path: 'legacy-note',
        name,
        kind: 'markdown',
        makeDefault: true,
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
      // Overwrites the empty record `seedIdbDocument` wrote: this suite is
      // about a body stored as a spatial text node, which is the shape a
      // pre-OKF note has on disk.
      await new LoroStore().save(legacyId, doc.export({ mode: 'snapshot' }))
      return legacyId
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
      const store = new IdbDocumentIndex()
      await seedLegacyNote(store, 'Legacy note')
      const first = render(<BrowserDocumentPage store={store} />)

      // focusEditable rather than focus() on the node resolved a moment ago:
      // under load the contentDOM can arrive late or be swapped, and focus()
      // on a detached element is a spec'd no-op that no wait here would
      // recover from — the keystrokes simply go nowhere. It also answers the
      // reason a click is wrong on this page: there are TWO role=textbox
      // elements (the title input and CodeMirror's content), so a click
      // locator on the contenteditable is ambiguous under strict mode.
      await focusEditable(() => document.querySelector('[contenteditable="true"]'))
      await userEvent.keyboard('{Control>}{End}{/Control}{Enter}and an appended line')
      await waitFor(() => {
        expect(document.querySelector('.cm-content')?.textContent).toContain('and an appended line')
      })

      await waitForSaved()
      first.unmount()

      render(<BrowserDocumentPage store={store} />)
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
      const store = new IdbDocumentIndex()
      const LEGACY_ID = await seedLegacyNote(store, 'Legacy embed target')
      await seedIdbDocument(store, {
        path: 'embed-source',
        name: 'Embed source',
        kind: 'markdown',
        makeDefault: true,
      })
      render(<BrowserDocumentPage store={store} />)

      // focusEditable rather than focus() on the node resolved a moment ago:
      // under load the contentDOM can arrive late or be swapped, and focus()
      // on a detached element is a spec'd no-op that no wait here would
      // recover from — the keystrokes simply go nowhere. It also answers the
      // reason a click is wrong on this page: there are TWO role=textbox
      // elements (the title input and CodeMirror's content), so a click
      // locator on the contenteditable is ambiguous under strict mode.
      await focusEditable(() => document.querySelector('[contenteditable="true"]'))
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

  /**
   * Someone who types `# Weekly review` has said what the note is called.
   * Before this the workspace kept calling it `untitled` — in the card, the
   * URL and every search result — and the only fix was typing the same words
   * again into the rename dialog. The two cases below are the seed and its
   * gate; the pure halves are covered by title-from-body and
   * new-document-path, so what these pin is the WIRING through a real save.
   */
  it('names an unnamed note after the title its body announces', async () => {
    const store = new IdbDocumentIndex()
    await seedIdbDocument(store, { path: 'untitled', kind: 'markdown', makeDefault: true })
    render(<BrowserDocumentPage store={store} />)

    const resolveEditable = () => document.querySelector('[contenteditable="true"]')
    await waitFor(() => expect(resolveEditable()).not.toBeNull())
    await focusEditable(resolveEditable)
    await userEvent.keyboard('# Weekly review')
    await waitFor(() => {
      expect(document.querySelector('.cm-content')?.textContent).toBe('# Weekly review')
    })

    await waitFor(
      async () => {
        const row = (await listLocalDocuments(new FoldingBrowserIndex())).find(
          (r) => r.kind === 'markdown',
        )
        expect(row?.name).toBe('Weekly review')
      },
      { timeout: 10_000 },
    )
  })

  /**
   * The counterexample CI found, pinned before the fix. Typing outlasts the
   * 500ms debounce on a loaded machine, so a save lands while the heading is
   * half written — and the first version of this seeding took that partial
   * heading and stopped, because a name being present is what closed its
   * gate. Measured in a real browser: `# From` … ` the list` produced a
   * document called "From", forever. A wrong name is worse than `untitled`,
   * because it looks deliberate.
   */
  it('keeps up with a heading that outlasts the save debounce', async () => {
    const store = new IdbDocumentIndex()
    await seedIdbDocument(store, { path: 'untitled', kind: 'markdown', makeDefault: true })
    render(<BrowserDocumentPage store={store} />)

    const markdownRow = async () =>
      (await listLocalDocuments(new FoldingBrowserIndex())).find((r) => r.kind === 'markdown')

    const resolveEditable = () => document.querySelector('[contenteditable="true"]')
    await waitFor(() => expect(resolveEditable()).not.toBeNull())
    await focusEditable(resolveEditable)

    await userEvent.keyboard('# From')
    // Long enough for a save to land on the partial heading — the whole
    // point. Waiting for the name to BECOME "From" would pass vacuously if
    // the seeding never ran at all, so this waits for the write instead.
    await waitFor(async () => expect((await markdownRow())?.name).toBe('From'), {
      timeout: 10_000,
    })

    await userEvent.keyboard(' the list')
    await waitFor(async () => expect((await markdownRow())?.name).toBe('From the list'), {
      timeout: 10_000,
    })
  })

  it('never touches a name a person chose', async () => {
    const store = new IdbDocumentIndex()
    await seedIdbDocument(store, {
      path: 'untitled',
      name: 'Meeting',
      kind: 'markdown',
      makeDefault: true,
    })
    render(<BrowserDocumentPage store={store} />)

    const markdownRow = async () =>
      (await listLocalDocuments(new FoldingBrowserIndex())).find((r) => r.kind === 'markdown')
    const before = (await markdownRow())?.updatedAt

    const resolveEditable = () => document.querySelector('[contenteditable="true"]')
    await waitFor(() => expect(resolveEditable()).not.toBeNull())
    await focusEditable(resolveEditable)
    await userEvent.keyboard('# From the list')

    // Wait for a save to land, so the absence below is a decision rather
    // than something that had not happened yet.
    await waitFor(async () => expect((await markdownRow())?.updatedAt).not.toBe(before), {
      timeout: 10_000,
    })
    expect((await markdownRow())?.name).toBe('Meeting')
  })

  it('leaves a note with no title unnamed rather than inventing one', async () => {
    const store = new IdbDocumentIndex()
    await seedIdbDocument(store, { path: 'untitled', kind: 'markdown', makeDefault: true })
    render(<BrowserDocumentPage store={store} />)

    const markdownRow = async () =>
      (await listLocalDocuments(new FoldingBrowserIndex())).find((r) => r.kind === 'markdown')
    const before = (await markdownRow())?.updatedAt

    const resolveEditable = () => document.querySelector('[contenteditable="true"]')
    await waitFor(() => expect(resolveEditable()).not.toBeNull())
    await focusEditable(resolveEditable)
    await userEvent.keyboard('just some prose')
    await waitFor(() => {
      expect(document.querySelector('.cm-content')?.textContent).toBe('just some prose')
    })

    // Wait for a save to LAND before asserting the absence, rather than
    // waiting a fixed time and hoping: `touchContentTimestamp` moves
    // updatedAt on every save, so a changed stamp is proof the seeding path
    // ran and declined. Asserting the negative any earlier passes for the
    // wrong reason — nothing had happened yet.
    await waitFor(
      async () => {
        expect((await markdownRow())?.updatedAt).not.toBe(before)
      },
      { timeout: 10_000 },
    )

    // Still the path, projected by `entry.name ?? entry.path` — nobody named
    // it, and prose is not a title.
    expect((await markdownRow())?.name).toBe('untitled')
  })
})
