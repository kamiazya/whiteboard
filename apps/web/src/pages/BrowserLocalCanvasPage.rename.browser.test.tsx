import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { BrowserLocalCanvasPage } from './BrowserLocalCanvasPage.js'
import { IndexedDBStore } from '../lib/browser-local-store.js'
// Real app styles so layout assertions measure the shipped geometry.
import '../index.css'

async function clearDb(): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase('whiteboard')
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
  })
}

describe('BrowserLocalCanvasPage rename (browser — real IndexedDB)', () => {
  beforeEach(async () => {
    await clearDb()
  })

  afterEach(() => {
    cleanup()
  })

  it('reload: edited title survives an unmount + fresh-store remount', async () => {
    render(<BrowserLocalCanvasPage store={new IndexedDBStore()} />)
    await waitFor(() => expect(screen.getByTestId('excalidraw-container')).toBeInTheDocument(), {
      timeout: 5000,
    })
    const titleInput = screen.getByRole('textbox', { name: /canvas title/i })
    titleInput.focus()
    fireEvent.change(titleInput, { target: { value: 'Reloaded title' } })
    titleInput.blur()
    await waitFor(
      () => expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Reloaded title'),
      { timeout: 5000 },
    )
    await waitFor(() => expect(screen.getByText('Saved')).toBeInTheDocument(), { timeout: 5000 })

    cleanup()
    render(<BrowserLocalCanvasPage store={new IndexedDBStore()} />)
    await waitFor(
      () => expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Reloaded title'),
      { timeout: 5000 },
    )
  })

  it('layout: excalidraw container still fills the viewport after editing the title', async () => {
    render(<BrowserLocalCanvasPage store={new IndexedDBStore()} />)
    await waitFor(() => expect(screen.getByTestId('excalidraw-container')).toBeInTheDocument(), {
      timeout: 5000,
    })
    const titleInput = screen.getByRole('textbox', { name: /canvas title/i })
    titleInput.focus()
    fireEvent.change(titleInput, { target: { value: 'Layout check' } })
    titleInput.blur()
    await waitFor(
      () => expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Layout check'),
      { timeout: 5000 },
    )
    const container = screen.getByTestId('excalidraw-container')
    expect(container.clientHeight).toBeGreaterThan(300)
    expect(container.clientWidth).toBeGreaterThan(600)
  })

  it("keyboard isolation: Enter/Escape/Backspace/Delete typed in the title do not reach Excalidraw's document-level shortcut handlers", async () => {
    render(<BrowserLocalCanvasPage store={new IndexedDBStore()} />)
    await waitFor(() => expect(screen.getByTestId('excalidraw-container')).toBeInTheDocument(), {
      timeout: 5000,
    })
    const documentKeyDown = vi.fn()
    document.addEventListener('keydown', documentKeyDown)
    try {
      const titleInput = screen.getByRole('textbox', { name: /canvas title/i })
      titleInput.focus()
      fireEvent.change(titleInput, { target: { value: 'Typing in title' } })
      for (const key of ['Enter', 'Escape', 'Backspace', 'Delete']) {
        fireEvent.keyDown(titleInput, { key })
      }
      expect(documentKeyDown).not.toHaveBeenCalled()
      // The canvas editor is still mounted and unaffected.
      expect(screen.getByTestId('excalidraw-container')).toBeInTheDocument()
    } finally {
      document.removeEventListener('keydown', documentKeyDown)
    }
  })

  it('Escape during edit reverts without persisting to IndexedDB', async () => {
    render(<BrowserLocalCanvasPage store={new IndexedDBStore()} />)
    await waitFor(() => expect(screen.getByTestId('excalidraw-container')).toBeInTheDocument(), {
      timeout: 5000,
    })
    const titleInput = screen.getByRole('textbox', { name: /canvas title/i })
    titleInput.focus()
    fireEvent.change(titleInput, { target: { value: 'Should not persist' } })
    fireEvent.keyDown(titleInput, { key: 'Escape' })
    await waitFor(
      () => expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('untitled'),
      { timeout: 5000 },
    )

    cleanup()
    render(<BrowserLocalCanvasPage store={new IndexedDBStore()} />)
    await waitFor(
      () => expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('untitled'),
      { timeout: 5000 },
    )
  })

  it("whitespace-only commit persists 'untitled' and restores it on remount", async () => {
    render(<BrowserLocalCanvasPage store={new IndexedDBStore()} />)
    await waitFor(() => expect(screen.getByTestId('excalidraw-container')).toBeInTheDocument(), {
      timeout: 5000,
    })
    const titleInput = screen.getByRole('textbox', { name: /canvas title/i })
    // Commit a real name first so the remount assertion below can distinguish
    // "restored the whitespace-commit's normalized value" from "never persisted
    // anything, so it's just showing the initial default".
    titleInput.focus()
    fireEvent.change(titleInput, { target: { value: 'Named canvas' } })
    titleInput.blur()
    await waitFor(
      () => expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Named canvas'),
      { timeout: 5000 },
    )
    await waitFor(() => expect(screen.getByText('Saved')).toBeInTheDocument(), { timeout: 5000 })

    titleInput.focus()
    fireEvent.change(titleInput, { target: { value: '   ' } })
    titleInput.blur()
    await waitFor(
      () => expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('untitled'),
      { timeout: 5000 },
    )
    await waitFor(() => expect(screen.getByText('Saved')).toBeInTheDocument(), { timeout: 5000 })

    cleanup()
    render(<BrowserLocalCanvasPage store={new IndexedDBStore()} />)
    await waitFor(
      () => expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('untitled'),
      { timeout: 5000 },
    )
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
    render(<BrowserLocalCanvasPage store={new IndexedDBStore()} />)
    await waitFor(() => expect(screen.getByTestId('excalidraw-container')).toBeInTheDocument(), {
      timeout: 5000,
    })
    const titleInput = screen.getByRole('textbox', { name: /canvas title/i })
    titleInput.focus()
    fireEvent.change(titleInput, { target: { value: 'Network check' } })
    titleInput.blur()
    await waitFor(
      () => expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Network check'),
      { timeout: 5000 },
    )
    const daemonCalls = calls.filter(
      (url) => url.includes('/api/') || url.includes('localhost:3') || url.includes('127.0.0.1'),
    )
    expect(daemonCalls).toHaveLength(0)
    spy.mockRestore()
  })
})
