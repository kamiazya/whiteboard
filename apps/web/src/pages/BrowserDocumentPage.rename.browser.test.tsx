import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IdbDocumentIndex } from '../lib/idb-document-index.js'
import { BrowserDocumentPage } from './BrowserDocumentPage.js'
// Real app styles so layout assertions measure the shipped geometry.
import '../index.css'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'

const ISOLATED_DB = claimIsolatedWhiteboardDb('browserdocumentpage-rename')

// The page reads/writes the canvas id through the router, so it needs a router
// in scope exactly as it has one in main.tsx.
function render(ui: ReactElement) {
  return rtlRender(
    // Pages fill their allotted height (h-full) — the app shell owns the
    // viewport in production, so tests supply the equivalent sized parent.
    <div style={{ height: '100vh' }}>
      <MemoryRouter initialEntries={['/']}>{ui}</MemoryRouter>
    </div>,
  )
}

async function clearDb(): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(ISOLATED_DB)
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
  })
}

async function renderLoaded(): Promise<void> {
  render(<BrowserDocumentPage store={new IdbDocumentIndex()} />)
  await waitFor(() => expect(screen.getByTestId('spatial-editor-container')).toBeInTheDocument(), {
    timeout: 5000,
  })
}

async function waitForTitle(expected: string): Promise<void> {
  await waitFor(
    () => expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(expected),
    { timeout: 5000 },
  )
}

// The title is the document's ONE rename surface and is always mounted, so
// there is no menu to open first. ("all" + most recent guards only against a
// stale tree transiently coexisting with a freshly remounted one, which the
// remount-based tests below can produce.)
async function titleField(): Promise<HTMLElement> {
  const all = await waitFor(() => screen.getAllByRole('textbox', { name: /^title$/i }), {
    timeout: 5000,
  })
  return all[all.length - 1]!
}

/**
 * The rename's write has LANDED, from the persistence facts the page
 * publishes hidden — the row itself draws no save state. `saved` alone is
 * true of a document never written, so the timestamp is what proves it.
 */
async function waitForWriteLanded(): Promise<void> {
  await waitFor(
    () => {
      const fact = screen.getByTestId('persistence-state')
      expect(fact.getAttribute('data-save-state')).toBe('saved')
      expect(fact.getAttribute('data-last-saved-at')).toBeTruthy()
    },
    { timeout: 5000 },
  )
}

describe('BrowserDocumentPage rename (real IndexedDB)', () => {
  beforeEach(async () => {
    await clearDb()
  })

  afterEach(() => {
    cleanup()
  })

  it('Enter ends the title edit; a composing Enter keeps it open', async () => {
    await renderLoaded()
    const titleInput = await titleField()
    titleInput.focus()
    fireEvent.change(titleInput, { target: { value: '\u4f01\u753b' } })
    // The Enter that confirms an IME conversion must hold the field open.
    fireEvent.keyDown(titleInput, { key: 'Enter', isComposing: true })
    expect(document.activeElement).toBe(titleInput)

    // The plain Enter is "I am done": the field blurs, the name stands, and
    // the landed write is the receipt.
    fireEvent.keyDown(titleInput, { key: 'Enter' })
    expect(document.activeElement).not.toBe(titleInput)
    await waitForTitle('\u4f01\u753b')
    await waitForWriteLanded()
  })

  it('reload: edited title survives an unmount + fresh-store remount', async () => {
    await renderLoaded()
    const titleInput = await titleField()
    titleInput.focus()
    fireEvent.change(titleInput, { target: { value: 'Reloaded title' } })
    titleInput.blur()
    await waitForTitle('Reloaded title')
    await waitForWriteLanded()

    cleanup()
    render(<BrowserDocumentPage store={new IdbDocumentIndex()} />)
    await waitForTitle('Reloaded title')
  })

  it('layout: spatial editor container still fills the viewport after editing the title', async () => {
    await renderLoaded()
    const titleInput = await titleField()
    titleInput.focus()
    fireEvent.change(titleInput, { target: { value: 'Layout check' } })
    titleInput.blur()
    await waitForTitle('Layout check')
    const container = screen.getByTestId('spatial-editor-container')
    expect(container.clientHeight).toBeGreaterThan(300)
    expect(container.clientWidth).toBeGreaterThan(600)
  })

  it("keyboard isolation: title keys never reach the editor's shortcut handlers", async () => {
    await renderLoaded()
    const documentKeyDown = vi.fn()
    document.addEventListener('keydown', documentKeyDown)
    try {
      const titleInput = await titleField()
      titleInput.focus()
      fireEvent.change(titleInput, { target: { value: 'Typing in title' } })
      for (const key of ['Backspace', 'Delete']) {
        fireEvent.keyDown(titleInput, { key })
      }
      fireEvent.keyDown(titleInput, { key: 'Escape' })

      const titleInput2 = await titleField()
      fireEvent.keyDown(titleInput2, { key: 'Enter' })

      expect(documentKeyDown).not.toHaveBeenCalled()
      // The canvas editor is still mounted and unaffected.
      expect(screen.getByTestId('spatial-editor-container')).toBeInTheDocument()
    } finally {
      document.removeEventListener('keydown', documentKeyDown)
    }
  })

  // The field commits per keystroke, so Escape puts the previous name back
  // rather than discarding a draft. Real IndexedDB and real timing here: the
  // failure this pins is the ABANDONED name landing after the restore, which
  // an assertion that stops at the first match sails straight past.
  it('Escape restores the previous name and the abandoned one never lands', async () => {
    await renderLoaded()
    const titleInput = await titleField()
    titleInput.focus()
    fireEvent.change(titleInput, { target: { value: 'Should not persist' } })
    fireEvent.keyDown(titleInput, { key: 'Escape' })
    await waitForTitle('untitled')

    // Settle everything still in flight before believing the restore held.
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('untitled')

    cleanup()
    render(<BrowserDocumentPage store={new IdbDocumentIndex()} />)
    await waitForTitle('untitled')
  })

  it("whitespace-only commit persists 'untitled' and restores it on remount", async () => {
    await renderLoaded()
    // Commit a real name first so the remount assertion below can distinguish
    // "restored the whitespace-commit's normalized value" from "never persisted
    // anything, so it's just showing the initial default".
    const titleInput = await titleField()
    titleInput.focus()
    fireEvent.change(titleInput, { target: { value: 'Named canvas' } })
    titleInput.blur()
    await waitForTitle('Named canvas')
    await waitForWriteLanded()

    const titleInput2 = await titleField()
    titleInput2.focus()
    fireEvent.change(titleInput2, { target: { value: '   ' } })
    titleInput2.blur()
    await waitForTitle('untitled')
    await waitForWriteLanded()

    cleanup()
    render(<BrowserDocumentPage store={new IdbDocumentIndex()} />)
    await waitForTitle('untitled')
  })

  it('network-negative: editing the title triggers no fetch to /api/ or daemon endpoints', async () => {
    const calls: string[] = []
    const original = window.fetch.bind(window)
    const spy = vi.spyOn(window, 'fetch').mockImplementation((...args) => {
      const url =
        typeof args[0] === 'string'
          ? args[0]
          : args[0] instanceof URL
            ? args[0].href
            : (args[0] as Request).url
      calls.push(url)
      return original(...args)
    })
    await renderLoaded()
    const titleInput = await titleField()
    titleInput.focus()
    fireEvent.change(titleInput, { target: { value: 'Network check' } })
    titleInput.blur()
    await waitForTitle('Network check')
    const daemonCalls = calls.filter(
      (url) => url.includes('/api/') || url.includes('localhost:3') || url.includes('127.0.0.1'),
    )
    expect(daemonCalls).toHaveLength(0)
    spy.mockRestore()
  })
})
