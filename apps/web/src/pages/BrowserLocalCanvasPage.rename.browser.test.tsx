import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IndexedDBStore } from '../lib/browser-local-store.js'
import { BrowserLocalCanvasPage } from './BrowserLocalCanvasPage.js'
// Real app styles so layout assertions measure the shipped geometry.
import '../index.css'

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
    const req = indexedDB.deleteDatabase('whiteboard')
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
  })
}

async function renderLoaded(): Promise<void> {
  render(<BrowserLocalCanvasPage store={new IndexedDBStore()} />)
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

// The rename input lives behind WorkspaceTopBar's "Canvas actions" menu
// rather than being always-mounted, so each edit starts by opening it.
//
// In real-browser mode, the first time this specific trigger is opened in a
// given test file it occasionally does not register on the first
// pointerdown, and a stale tree can transiently coexist with a freshly
// remounted one across a retry (never reproduces in jsdom). Retry with a
// full remount, and query "all" + take the most recent match, rather than
// let that tooling artifact fail a real behavioral assertion.
async function openRenameInput(): Promise<HTMLElement> {
  let renameItem: HTMLElement | undefined
  for (let attempt = 0; attempt < 8 && !renameItem; attempt++) {
    if (attempt > 0) {
      cleanup()
      await renderLoaded()
    }
    const allCanvasActions = await waitFor(() => screen.getAllByLabelText('Canvas actions'), {
      timeout: 5000,
    })
    const canvasActions = allCanvasActions[allCanvasActions.length - 1]!
    fireEvent.pointerDown(canvasActions, { button: 0, ctrlKey: false })
    try {
      const allRenameItems = await waitFor(() => screen.getAllByText('Rename canvas'), {
        timeout: 1500,
      })
      renameItem = allRenameItems[allRenameItems.length - 1]!
    } catch {
      // retry with a fresh remount
    }
  }
  if (!renameItem) throw new Error('Canvas actions dropdown never opened after retries')
  fireEvent.pointerUp(renameItem)
  const allTitleInputs = await waitFor(
    () => screen.getAllByRole('textbox', { name: /canvas title/i }),
    { timeout: 3000 },
  )
  return allTitleInputs[allTitleInputs.length - 1]!
}

describe('BrowserLocalCanvasPage rename (browser — real IndexedDB)', () => {
  beforeEach(async () => {
    await clearDb()
  })

  afterEach(() => {
    cleanup()
  })

  it('reload: edited title survives an unmount + fresh-store remount', async () => {
    await renderLoaded()
    const titleInput = await openRenameInput()
    titleInput.focus()
    fireEvent.change(titleInput, { target: { value: 'Reloaded title' } })
    titleInput.blur()
    await waitForTitle('Reloaded title')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Saved' })).toBeInTheDocument(), {
      timeout: 5000,
    })

    cleanup()
    render(<BrowserLocalCanvasPage store={new IndexedDBStore()} />)
    await waitForTitle('Reloaded title')
  })

  it('layout: spatial editor container still fills the viewport after editing the title', async () => {
    await renderLoaded()
    const titleInput = await openRenameInput()
    titleInput.focus()
    fireEvent.change(titleInput, { target: { value: 'Layout check' } })
    titleInput.blur()
    await waitForTitle('Layout check')
    const container = screen.getByTestId('spatial-editor-container')
    expect(container.clientHeight).toBeGreaterThan(300)
    expect(container.clientWidth).toBeGreaterThan(600)
  })

  it("keyboard isolation: Enter/Escape/Backspace/Delete typed in the title do not reach the spatial editor's document-level shortcut handlers", async () => {
    await renderLoaded()
    const documentKeyDown = vi.fn()
    document.addEventListener('keydown', documentKeyDown)
    try {
      // Enter and Escape both close the rename affordance in WorkspaceTopBar,
      // so exercise Backspace/Delete on one open input, then Enter and Escape
      // each on their own freshly-opened input.
      const titleInput = await openRenameInput()
      titleInput.focus()
      fireEvent.change(titleInput, { target: { value: 'Typing in title' } })
      for (const key of ['Backspace', 'Delete']) {
        fireEvent.keyDown(titleInput, { key })
      }
      fireEvent.keyDown(titleInput, { key: 'Escape' })

      const titleInput2 = await openRenameInput()
      fireEvent.keyDown(titleInput2, { key: 'Enter' })

      expect(documentKeyDown).not.toHaveBeenCalled()
      // The canvas editor is still mounted and unaffected.
      expect(screen.getByTestId('spatial-editor-container')).toBeInTheDocument()
    } finally {
      document.removeEventListener('keydown', documentKeyDown)
    }
  })

  it('Escape during edit reverts without persisting to IndexedDB', async () => {
    await renderLoaded()
    const titleInput = await openRenameInput()
    titleInput.focus()
    fireEvent.change(titleInput, { target: { value: 'Should not persist' } })
    fireEvent.keyDown(titleInput, { key: 'Escape' })
    await waitForTitle('untitled')

    cleanup()
    render(<BrowserLocalCanvasPage store={new IndexedDBStore()} />)
    await waitForTitle('untitled')
  })

  it("whitespace-only commit persists 'untitled' and restores it on remount", async () => {
    await renderLoaded()
    // Commit a real name first so the remount assertion below can distinguish
    // "restored the whitespace-commit's normalized value" from "never persisted
    // anything, so it's just showing the initial default".
    const titleInput = await openRenameInput()
    titleInput.focus()
    fireEvent.change(titleInput, { target: { value: 'Named canvas' } })
    titleInput.blur()
    await waitForTitle('Named canvas')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Saved' })).toBeInTheDocument(), {
      timeout: 5000,
    })

    const titleInput2 = await openRenameInput()
    titleInput2.focus()
    fireEvent.change(titleInput2, { target: { value: '   ' } })
    titleInput2.blur()
    await waitForTitle('untitled')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Saved' })).toBeInTheDocument(), {
      timeout: 5000,
    })

    cleanup()
    render(<BrowserLocalCanvasPage store={new IndexedDBStore()} />)
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
    const titleInput = await openRenameInput()
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
