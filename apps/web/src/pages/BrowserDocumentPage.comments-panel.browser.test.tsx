/**
 * The comments panel, mounted (ADR-0026 decision 5). What this asserts that
 * the panel's own component test cannot is the WIRING: a thread stored in
 * the document's threads plane reaches the panel, through the session's
 * annotation channel and the page.
 *
 * SpatialEditor is mocked — the subject is the document-level surface, not
 * the canvas — which is also the point. The panel is not canvas chrome: it
 * has to serve a markdown document, and a markdown document has no canvas to
 * hang anything on.
 */
import { writeCommentThread, writeMarkdownBody } from '@kamiazya/whiteboard-loro-adapter'
import type { DocumentBackendHandlers } from '@kamiazya/whiteboard-mcp/browser-contract'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, render as rtlRender, screen, waitFor, within } from '@testing-library/react'
import { LoroDoc } from 'loro-crdt'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import type { DocumentSnapshot } from '../lib/whiteboard-client.js'
import { focusEditable } from '../test-utils/focus-editable.js'
import { LocalStoreDouble } from '../test-utils/local-index.js'
import '../index.css'

vi.mock('../components/spatial-editor/index.js', () => ({
  // Fills its host the way the real editor does. A zero-height stand-in makes
  // any geometric assertion about the surface vacuous — the overlap case below
  // passed against the very layout it exists to reject.
  SpatialEditor: (_props: { canvas: SpatialCanvas }) => (
    <div data-testid="mock-spatial-editor" style={{ height: '100%', width: '100%' }} />
  ),
}))

vi.mock('../lib/browser-backend.js', async () => {
  const { FakeBrowserBackend, workspaceSnapshotFor } = await import(
    '../test-utils/fake-browser-backend.js'
  )
  const { documentContainers: containersOf, writeCommentThread: writeThread } = await import(
    '@kamiazya/whiteboard-loro-adapter'
  )
  const { LoroDoc: Doc } = await import('loro-crdt')
  class ThreadSeedingBackend extends FakeBrowserBackend {
    // Named from the published contract rather than derived off the base
    // class: inside a `vi.mock` factory the base is a dynamic import, so a
    // `Parameters<…>` lookup over it resolves to `unknown`.
    connect(handlers: DocumentBackendHandlers): void {
      // Rebuilt from the shared helper's snapshot so the workspace-document
      // shape stays the real one; only the threads plane is added on top.
      const doc = new Doc()
      doc.import(workspaceSnapshotFor(this.target, { nodes: [], edges: [] }))
      const content = containersOf(doc, this.target.documentId)
      writeThread(content, {
        id: 't-open',
        anchor: { kind: 'spatial', x: 20, y: 30 },
        status: 'open',
        messages: [{ id: 'm1', body: 'still needs a decision' }],
      })
      writeThread(content, {
        id: 't-done',
        anchor: { kind: 'spatial', x: 40, y: 50 },
        status: 'resolved',
        messages: [{ id: 'm2', body: 'settled last week' }],
      })
      // Anchored to a node the canvas does not contain. The canvas seeded
      // above has no nodes at all, so this anchor cannot resolve — which is
      // what makes the thread orphaned rather than merely unplaced.
      writeThread(content, {
        id: 't-orphan',
        anchor: { kind: 'spatial', nodeId: 'n-deleted', x: 60, y: 70 },
        status: 'open',
        messages: [{ id: 'm3', body: 'about a node that was deleted' }],
      })
      handlers.onConnected()
      handlers.onSnapshot(doc.export({ mode: 'snapshot' }))
    }
  }
  return { BrowserBackend: ThreadSeedingBackend }
})

const { BrowserDocumentPage } = await import('./BrowserDocumentPage.js')

function render(ui: ReactElement) {
  return rtlRender(
    <div style={{ height: '100vh' }}>
      <MemoryRouter initialEntries={['/']}>{ui}</MemoryRouter>
    </div>,
  )
}

const snap: DocumentSnapshot = {
  documentId: '0W16BGNTZ49EKRX27CHPV05AFM',
  workspaceId: 'local',
  path: 'notes/reviewed',
  name: 'Reviewed',
  updatedAt: '2026-09-03T00:00:00.000Z',
  kind: 'spatial' as const,
}

afterEach(() => {
  cleanup()
})

it('opens a rail listing this document conversations, open ones first and by default', async () => {
  const store = new LocalStoreDouble()
  await store.setDefaultDocumentId(snap.documentId)
  await store.save(snap)

  render(<BrowserDocumentPage store={store.index} pointer={store.pointer} clock={store.clock} />)
  await screen.findByTestId('mock-spatial-editor', undefined, { timeout: 15_000 })

  // Closed by default: the panel answers a question the reader asks, rather
  // than taking a rail's width from everyone who never asks it.
  expect(screen.queryByTestId('comments-panel')).toBeNull()

  await userEvent.click(await screen.findByRole('button', { name: /comments/i }))

  await waitFor(() => expect(screen.getByText('still needs a decision')).toBeInTheDocument(), {
    timeout: 15_000,
  })
  // Resolved is one filter away, not on screen by default.
  expect(screen.queryByText('settled last week')).toBeNull()
})

it('counts the OPEN conversations on the opener, so the rail need not be open to know', async () => {
  const store = new LocalStoreDouble()
  await store.setDefaultDocumentId(snap.documentId)
  await store.save(snap)

  render(<BrowserDocumentPage store={store.index} pointer={store.pointer} clock={store.clock} />)
  await screen.findByTestId('mock-spatial-editor', undefined, { timeout: 15_000 })

  // One of the three threads is resolved; a badge counting all of them would
  // report work that is done as work outstanding.
  await waitFor(() => expect(screen.getByRole('button', { name: /comments, 2 open/i })), {
    timeout: 15_000,
  })
})

it('marks a thread whose node is gone, instead of leaving it indistinguishable', async () => {
  const store = new LocalStoreDouble()
  await store.setDefaultDocumentId(snap.documentId)
  await store.save(snap)

  render(<BrowserDocumentPage store={store.index} pointer={store.pointer} clock={store.clock} />)
  await screen.findByTestId('mock-spatial-editor', undefined, { timeout: 15_000 })
  await userEvent.click(await screen.findByRole('button', { name: /comments/i }))

  // ADR-0026 decision 4: deleting the subject of a conversation must not
  // delete the conversation. The panel has always been able to SAY this; the
  // mount passed it no resolver, so nothing was ever marked and the claim
  // was carried entirely by the panel's own component test.
  await waitFor(() => expect(screen.getByTestId('thread-orphaned-t-orphan')).toBeInTheDocument(), {
    timeout: 15_000,
  })
  // The one anchored to bare coordinates still resolves — a comment placed on
  // empty canvas has nothing to outlive.
  expect(screen.queryByTestId('thread-orphaned-t-open')).toBeNull()
})

it('keeps the opener out of the editor surface, so it cannot swallow the editor own controls', async () => {
  const store = new LocalStoreDouble()
  await store.setDefaultDocumentId(snap.documentId)
  await store.save(snap)

  render(<BrowserDocumentPage store={store.index} pointer={store.pointer} clock={store.clock} />)
  const surface = await screen.findByTestId('mock-spatial-editor', undefined, { timeout: 15_000 })
  const opener = await screen.findByRole('button', { name: /comments/i })

  // A geometric assertion rather than a class one: floated over the surface's
  // top-right corner, this control sat on top of whatever chrome the mounted
  // editor puts there — measured, the markdown editor's own catalog trigger,
  // which then could not be clicked at all. Where the opener lives is a
  // decision; that it overlaps nothing is the invariant.
  const a = opener.getBoundingClientRect()
  const b = surface.getBoundingClientRect()
  const overlaps = a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
  expect({ overlaps, opener: a.toJSON(), surface: b.toJSON() }).toMatchObject({ overlaps: false })
})

/**
 * A markdown document's own record, holding one conversation.
 *
 * Seeded into the LEGACY per-document shape because that is the host a
 * markdown document reaches when this browser has no workspace record for
 * it, which is what an injected store double leaves behind — and it is the
 * `threads` plane either way, since the plane is a peer of `body` rather
 * than something inside a canvas envelope.
 */
function noteHoldingOneThread(): Uint8Array {
  const doc = new LoroDoc()
  writeCommentThread(doc, {
    id: 't-note',
    anchor: { kind: 'text', quote: { exact: 'the second paragraph' }, start: 12, end: 32 },
    status: 'open',
    messages: [{ id: 'm1', body: 'is this still true?' }],
  })
  return doc.export({ mode: 'snapshot' })
}

const note = { ...snap, kind: 'markdown' as const, documentId: '0W16BGNTZ49EKRX27CHPV05AFN' }

it('lists a markdown document conversations, which no session is there to deliver', async () => {
  // The gap this closes. A markdown document is given NO BrowserBackend on
  // purpose — the spatial sync layer persists a body-less doc to the same id
  // and would clobber the body — so `useDocumentSync` stays idle and its
  // annotation channel answers `[]` forever. The rail was therefore
  // permanently empty on a note, and its opener permanently read `0`, over
  // threads an MCP peer could write and nothing in the app could read.
  const store = new LocalStoreDouble()
  await store.setDefaultDocumentId(note.documentId)
  await store.save(note)
  await store.loro.save(note.documentId, noteHoldingOneThread())

  render(
    <BrowserDocumentPage
      store={store.index}
      pointer={store.pointer}
      clock={store.clock}
      loro={store.loro}
    />,
  )

  // The count too: it is read off the same list, so a rail that fills while
  // the opener still says nothing would be half a fix.
  await waitFor(() => expect(screen.getByRole('button', { name: /comments, 1 open/i })), {
    timeout: 15_000,
  })
  await userEvent.click(screen.getByRole('button', { name: /comments/i }))
  await waitFor(() => expect(screen.getByText('is this still true?')).toBeInTheDocument(), {
    timeout: 15_000,
  })
})

it('replies on a markdown document, where a reply has no session to travel through', async () => {
  // The page's reply handler dispatches an editor command through the sync
  // session, which for a note is wired to nothing — so without its own route
  // the rail would show a reply box that silently discards what is typed
  // into it, the one thing the panel's contract says a host must not offer.
  const store = new LocalStoreDouble()
  await store.setDefaultDocumentId(note.documentId)
  await store.save(note)
  await store.loro.save(note.documentId, noteHoldingOneThread())

  render(
    <BrowserDocumentPage
      store={store.index}
      pointer={store.pointer}
      clock={store.clock}
      loro={store.loro}
    />,
  )
  await userEvent.click(await screen.findByRole('button', { name: /comments/i }))
  await userEvent.click(await screen.findByText('is this still true?'))

  await userEvent.fill(await screen.findByRole('textbox', { name: /reply/i }), 'no, we changed it')
  await userEvent.click(screen.getByRole('button', { name: /^reply$/i }))

  await waitFor(() => expect(screen.getByText('no, we changed it')).toBeInTheDocument(), {
    timeout: 15_000,
  })
})

/** A markdown document with a body and no conversations on it yet. */
function noteHoldingABody(): Uint8Array {
  const doc = new LoroDoc()
  writeMarkdownBody(doc, 'Ship the report on Friday.')
  return doc.export({ mode: 'snapshot' })
}

it('opens a conversation from the markdown body, end to end', async () => {
  // Every layer below has its own test; what only this one can say is that
  // they are CONNECTED — a selection in CodeMirror reaches an anchor, the
  // anchor reaches the rail, and the rail's first message reaches the
  // threads plane the list is read back from. A note has no session, so the
  // create has to take the same separate route its reply does.
  const store = new LocalStoreDouble()
  await store.setDefaultDocumentId(note.documentId)
  await store.save(note)
  await store.loro.save(note.documentId, noteHoldingABody())

  render(
    <BrowserDocumentPage
      store={store.index}
      pointer={store.pointer}
      clock={store.clock}
      loro={store.loro}
    />,
  )

  // Through the resolver-taking helper rather than a held element: the
  // contentDOM lands late here (the page hydrates the document first) and a
  // node grabbed once is a snapshot of a mount that may be replaced.
  await focusEditable(
    () =>
      document
        .querySelector('[data-testid="markdown-source-pane"]')
        ?.querySelector('[contenteditable="true"]') ?? null,
  )
  await userEvent.keyboard('{Control>}{Home}{/Control}')
  for (let i = 0; i < 4; i++) await userEvent.keyboard('{Shift>}{ArrowRight}{/Shift}')

  await userEvent.click(await screen.findByRole('button', { name: 'Editing actions' }))
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Comment on this' }))

  // The rail OPENS on the gesture. Leaving it shut would hide the only place
  // the reader can now say anything, and the passage would be waiting in a
  // panel nobody was shown.
  const compose = await screen.findByTestId('comments-panel-compose', undefined, {
    timeout: 15_000,
  })
  // Asserted on the QUOTE, not on the box's concatenated text — the box also
  // carries the textarea and the submit button's label, so a whole-box
  // assertion only ever passed on a substring match.
  expect(within(compose).getByText('Ship')).toBeInTheDocument()

  await userEvent.fill(screen.getByRole('textbox', { name: /comment/i }), 'why Friday?')
  await userEvent.click(screen.getByRole('button', { name: /^comment$/i }))

  await waitFor(() => expect(screen.getByText('why Friday?')).toBeInTheDocument(), {
    timeout: 15_000,
  })
  // Read back from the layer, not from the draft that was typed: the count
  // comes off the same annotations list the document publishes.
  await waitFor(() => expect(screen.getByRole('button', { name: /comments, 1 open/i })), {
    timeout: 15_000,
  })
})

/**
 * A note whose one conversation is about a passage of its body, with no mark
 * on it — which is every document that arrived through a markdown file, and
 * every thread written before marks existed.
 */
function noteHoldingAMarkedPassage(): Uint8Array {
  const doc = new LoroDoc()
  writeMarkdownBody(doc, 'Ship the report on Friday.')
  writeCommentThread(doc, {
    id: 't-note',
    anchor: { kind: 'text', quote: { exact: 'report on Friday' }, start: 9, end: 25 },
    status: 'open',
    messages: [{ id: 'm1', body: 'why Friday?' }],
  })
  return doc.export({ mode: 'snapshot' })
}

it('keeps the body highlight through an edit inside its own passage', async () => {
  // The case the quote alone gets WRONG, driven through the real editor.
  // Typing inside a passage makes the stored quote stale — no occurrence of
  // it is left in the body — so a search-based resolver answers `orphaned`
  // and the highlight disappears out from under a reader mid-sentence. The
  // Loro mark belongs to the characters, so it simply grows by one.
  //
  // Two layers only this test connects: the backfill that gave an imported
  // thread its mark at load, and the projection that draws from the mark
  // rather than from the quote.
  const store = new LocalStoreDouble()
  await store.setDefaultDocumentId(note.documentId)
  await store.save(note)
  await store.loro.save(note.documentId, noteHoldingAMarkedPassage())

  render(
    <BrowserDocumentPage
      store={store.index}
      pointer={store.pointer}
      clock={store.clock}
      loro={store.loro}
    />,
  )

  const highlight = () => document.querySelector('.cm-annotation[data-thread-id="t-note"]')
  await waitFor(() => expect(highlight()).not.toBeNull(), { timeout: 15_000 })

  await focusEditable(
    () =>
      document
        .querySelector('[data-testid="markdown-source-pane"]')
        ?.querySelector('[contenteditable="true"]') ?? null,
  )
  // Into the middle of `report`, so what is typed lands strictly INSIDE the
  // passage — at either edge `expand: 'none'` would put it outside, which is
  // a different question and a deliberate one.
  await userEvent.keyboard('{Control>}{Home}{/Control}')
  for (let i = 0; i < 12; i++) await userEvent.keyboard('{ArrowRight}')
  await userEvent.keyboard('X')

  // Queried fresh, never held: the pane re-renders around this and a node
  // grabbed before the edit reports what it said when it was detached.
  await waitFor(() => expect(highlight()?.textContent).toBe('repXort on Friday'), {
    timeout: 15_000,
  })
})

it('offers the same opener on a markdown document, which has no canvas chrome to carry one', async () => {
  const store = new LocalStoreDouble()
  await store.setDefaultDocumentId(note.documentId)
  await store.save(note)

  render(<BrowserDocumentPage store={store.index} pointer={store.pointer} clock={store.clock} />)

  // The claim ADR-0026 decision 5 rests on: a document with no canvas still
  // reaches its conversations. Nothing else in this file would notice if the
  // opener rode canvas-only chrome.
  await waitFor(
    () => expect(screen.getByRole('button', { name: /comments/i })).toBeInTheDocument(),
    {
      timeout: 15_000,
    },
  )
  expect(screen.queryByTestId('mock-spatial-editor')).toBeNull()
})

/**
 * The background colour once it has stopped moving.
 *
 * The control transitions its colours, so a reading taken right after the
 * pointer leaves is a frame of the fade rather than a state. Measured, the
 * naive version compared a mid-transition `oklab(0.97 0 0 / 0.920548)`
 * against a settled `oklch(0.97 0 0)` and "passed" for a difference that was
 * pure animation — it survived deleting the styling it exists to pin.
 */
async function settledBackground(el: Element): Promise<string> {
  let previous = ''
  await waitFor(() => {
    const current = getComputedStyle(el).backgroundColor
    const settled = current === previous
    previous = current
    expect(settled).toBe(true)
  })
  return previous
}

it('shows the opener as pressed while the rail is open, not only to a screen reader', async () => {
  const store = new LocalStoreDouble()
  await store.setDefaultDocumentId(snap.documentId)
  await store.save(snap)

  render(<BrowserDocumentPage store={store.index} pointer={store.pointer} clock={store.clock} />)
  const editor = await screen.findByTestId('mock-spatial-editor', undefined, { timeout: 15_000 })
  const opener = await screen.findByRole('button', { name: /comments/i })

  // The pointer is parked off the control for both readings: a ghost button
  // takes the same `bg-accent` on :hover, so measuring where the click left
  // the cursor compares hovered-open against unhovered-closed.
  await userEvent.hover(editor)
  const closed = await settledBackground(opener)

  await userEvent.click(opener)
  await screen.findByTestId('comments-panel')
  await userEvent.hover(editor)
  const open = await settledBackground(opener)

  // Computed style rather than a class assertion: what a reader can SEE is
  // the claim, and a class name proves only that a string was written. The
  // attribute was already right — `aria-pressed` was set from the first
  // version — and the picture was identical either way.
  // Plain inequality, NOT `expect.not.stringMatching`: that matcher treats
  // its argument as a REGEX, so the parentheses in `rgba(0, 0, 0, 0)` become
  // groups and the pattern stops matching the literal it came from — it
  // passes for two IDENTICAL colours, which is exactly the vacuity this
  // assertion exists to avoid.
  expect(open).not.toBe(closed)
})

it('replies from the rail, and the reply joins the conversation it was typed into', async () => {
  // The whole local chain in one case: the panel's onReply dispatches
  // `reply-to-thread`, the session writes it into the threads plane, and the
  // annotation channel republishes — no remote echo involved, which is what
  // makes it observable here at all.
  const store = new LocalStoreDouble()
  await store.setDefaultDocumentId(snap.documentId)
  await store.save(snap)

  render(<BrowserDocumentPage store={store.index} pointer={store.pointer} clock={store.clock} />)
  await screen.findByTestId('mock-spatial-editor', undefined, { timeout: 15_000 })
  await userEvent.click(await screen.findByRole('button', { name: /comments/i }))
  await userEvent.click(await screen.findByText('still needs a decision'))

  await userEvent.fill(await screen.findByRole('textbox', { name: /reply/i }), 'decided: ship it')
  await userEvent.click(screen.getByRole('button', { name: /^reply$/i }))

  await waitFor(() => expect(screen.getByText('decided: ship it')).toBeInTheDocument(), {
    timeout: 15_000,
  })
})

/** The same note, but with a body the stored quote can actually be found in. */
function noteHoldingAPlacedThread(): Uint8Array {
  const doc = new LoroDoc()
  doc.getText('body').insert(0, 'A first line.\nThen the second paragraph, which is disputed.')
  writeCommentThread(doc, {
    id: 't-placed',
    anchor: { kind: 'text', quote: { exact: 'the second paragraph' }, start: 19, end: 39 },
    status: 'open',
    // Two, so the assertion below can tell an OPENED conversation from a
    // list that merely shows its first line as an excerpt.
    messages: [
      { id: 'm1', body: 'disputed by whom?' },
      { id: 'm2', body: 'by the reviewer' },
    ],
  })
  return doc.export({ mode: 'snapshot' })
}

it('reaches a note thread from the body: its gutter marker opens the rail on that conversation', async () => {
  // The round trip the rail alone could not close. A conversation about a
  // PASSAGE was reachable only by scanning a list that says nothing about
  // where in the document it points.
  const store = new LocalStoreDouble()
  await store.setDefaultDocumentId(note.documentId)
  await store.save(note)
  await store.loro.save(note.documentId, noteHoldingAPlacedThread())

  render(
    <BrowserDocumentPage
      store={store.index}
      pointer={store.pointer}
      clock={store.clock}
      loro={store.loro}
    />,
  )

  const marker = await waitFor(
    () => {
      const found = document.querySelector<HTMLElement>(
        '.cm-annotation-gutter-marker[data-thread-id="t-placed"]',
      )
      expect(found).not.toBeNull()
      return found as HTMLElement
    },
    { timeout: 15_000 },
  )
  // The passage itself is marked in the text, not only named in the margin.
  expect(document.querySelector('[data-thread-id="t-placed"].cm-annotation')?.textContent).toBe(
    'the second paragraph',
  )

  // The rail is shut until now: this press is what opens it.
  expect(screen.queryByTestId('comments-panel')).toBeNull()
  marker.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))

  await waitFor(() => expect(screen.getByText('by the reviewer')).toBeInTheDocument(), {
    timeout: 15_000,
  })
})
