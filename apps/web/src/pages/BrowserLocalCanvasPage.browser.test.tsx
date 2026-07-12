import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render as rtlRender, screen, waitFor, within } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { BrowserLocalCanvasPage } from './BrowserLocalCanvasPage.js'
import { IndexedDBStore } from '../lib/browser-local-store.js'
// Real app styles so layout assertions measure the shipped geometry.
import '../index.css'

// The page reads/writes the canvas id through the router, so it needs a router
// in scope exactly as it has one in main.tsx.
function render(ui: ReactElement) {
  return rtlRender(<MemoryRouter initialEntries={['/']}>{ui}</MemoryRouter>)
}

async function clearDb(): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase('whiteboard')
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
  })
}

describe('BrowserLocalCanvasPage (browser — real IndexedDB)', () => {
  beforeEach(async () => {
    await clearDb()
  })

  afterEach(() => {
    cleanup()
  })

  it('load: renders Excalidraw container after initial load', async () => {
    render(<BrowserLocalCanvasPage store={new IndexedDBStore()} />)
    await waitFor(() => expect(screen.getByTestId('excalidraw-container')).toBeInTheDocument(), {
      timeout: 5000,
    })
  })

  it('layout: excalidraw container fills the viewport below the header', async () => {
    // An unsized height chain collapses the container to 0px and the whiteboard
    // becomes invisible. The page must own its viewport height so the editor
    // area gets real geometry.
    render(<BrowserLocalCanvasPage store={new IndexedDBStore()} />)
    await waitFor(() => expect(screen.getByTestId('excalidraw-container')).toBeInTheDocument(), {
      timeout: 5000,
    })
    const container = screen.getByTestId('excalidraw-container')
    // Viewport is 1280x900; the editor area must occupy most of it.
    expect(container.clientHeight).toBeGreaterThan(300)
    expect(container.clientWidth).toBeGreaterThan(600)
  })

  it('cleanup: delete canvas shows cleanup-completed', async () => {
    render(<BrowserLocalCanvasPage store={new IndexedDBStore()} />)
    await waitFor(() => expect(screen.getByTestId('excalidraw-container')).toBeInTheDocument(), {
      timeout: 5000,
    })
    screen.getByRole('button', { name: /delete canvas/i }).click()
    const dialog = await screen.findByRole('alertdialog', undefined, { timeout: 5000 })
    within(dialog)
      .getByRole('button', { name: /^delete$/i })
      .click()
    await waitFor(() => expect(screen.getByTestId('cleanup-completed')).toBeInTheDocument(), {
      timeout: 5000,
    })
  })

  it('post-cleanup reload: remount after delete shows a fresh canvas', async () => {
    render(<BrowserLocalCanvasPage store={new IndexedDBStore()} />)
    await waitFor(() => expect(screen.getByTestId('excalidraw-container')).toBeInTheDocument(), {
      timeout: 5000,
    })
    screen.getByRole('button', { name: /delete canvas/i }).click()
    const dialog = await screen.findByRole('alertdialog', undefined, { timeout: 5000 })
    within(dialog)
      .getByRole('button', { name: /^delete$/i })
      .click()
    await waitFor(() => expect(screen.getByTestId('cleanup-completed')).toBeInTheDocument(), {
      timeout: 5000,
    })
    cleanup()
    render(<BrowserLocalCanvasPage store={new IndexedDBStore()} />)
    await waitFor(() => expect(screen.getByTestId('excalidraw-container')).toBeInTheDocument(), {
      timeout: 5000,
    })
  })

  it('network-negative: no fetch to /api/ or daemon endpoints during editing', async () => {
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
    // Wait a bit to catch any delayed fetch calls from async init.
    await new Promise((resolve) => setTimeout(resolve, 500))
    const daemonCalls = calls.filter(
      (url) => url.includes('/api/') || url.includes('localhost:3') || url.includes('127.0.0.1'),
    )
    expect(daemonCalls).toHaveLength(0)
    spy.mockRestore()
  })

  it('does not render an "Add rectangle" button', async () => {
    render(<BrowserLocalCanvasPage store={new IndexedDBStore()} />)
    await waitFor(() => expect(screen.getByTestId('excalidraw-container')).toBeInTheDocument(), {
      timeout: 5000,
    })
    expect(screen.queryByRole('button', { name: /add rectangle/i })).toBeNull()
  })
})
