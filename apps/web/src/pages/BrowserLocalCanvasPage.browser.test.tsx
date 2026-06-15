import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { BrowserLocalCanvasPage } from './BrowserLocalCanvasPage.js'
import { IndexedDBStore } from '../lib/browser-local-store.js'

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

  it('load: renders canvas editor after initial load', async () => {
    render(<BrowserLocalCanvasPage store={new IndexedDBStore()} />)
    await waitFor(() => expect(screen.getByTestId('canvas-editor')).toBeInTheDocument())
    expect(screen.getByTestId('element-count')).toHaveTextContent('0')
  })

  it('edit: add rectangle increments element count', async () => {
    render(<BrowserLocalCanvasPage store={new IndexedDBStore()} />)
    await waitFor(() => expect(screen.getByTestId('element-count')).toHaveTextContent('0'))
    fireEvent.click(screen.getByRole('button', { name: /add rectangle/i }))
    expect(screen.getByTestId('element-count')).toHaveTextContent('1')
    fireEvent.click(screen.getByRole('button', { name: /add rectangle/i }))
    expect(screen.getByTestId('element-count')).toHaveTextContent('2')
  })

  it('save/reload: elements persist in IndexedDB after remount', async () => {
    render(<BrowserLocalCanvasPage store={new IndexedDBStore()} />)
    await waitFor(() => expect(screen.getByTestId('element-count')).toHaveTextContent('0'))
    fireEvent.click(screen.getByRole('button', { name: /add rectangle/i }))
    expect(screen.getByTestId('element-count')).toHaveTextContent('1')
    // wait for the 1 s debounce to flush to real IDB
    await new Promise((resolve) => setTimeout(resolve, 1200))
    cleanup()
    render(<BrowserLocalCanvasPage store={new IndexedDBStore()} />)
    await waitFor(() => expect(screen.getByTestId('element-count')).toHaveTextContent('1'))
  })

  it('cleanup: delete canvas shows cleanup-completed', async () => {
    render(<BrowserLocalCanvasPage store={new IndexedDBStore()} />)
    await waitFor(() => expect(screen.getByTestId('canvas-editor')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /delete canvas/i }))
    await waitFor(() => expect(screen.getByTestId('cleanup-completed')).toBeInTheDocument())
  })

  it('post-cleanup reload: non-empty canvas deleted from IDB — reload shows fresh blank canvas', async () => {
    render(<BrowserLocalCanvasPage store={new IndexedDBStore()} />)
    await waitFor(() => expect(screen.getByTestId('element-count')).toHaveTextContent('0'))
    // persist a non-empty canvas to real IDB
    fireEvent.click(screen.getByRole('button', { name: /add rectangle/i }))
    expect(screen.getByTestId('element-count')).toHaveTextContent('1')
    await new Promise((resolve) => setTimeout(resolve, 1200))
    // verify IDB has the element before deleting
    fireEvent.click(screen.getByRole('button', { name: /delete canvas/i }))
    await waitFor(() => expect(screen.getByTestId('cleanup-completed')).toBeInTheDocument())
    cleanup()
    // remount — IDB is now empty; a fresh canvas with 0 elements should be created
    render(<BrowserLocalCanvasPage store={new IndexedDBStore()} />)
    await waitFor(() => expect(screen.getByTestId('element-count')).toHaveTextContent('0'))
    expect(screen.getByTestId('canvas-editor')).toBeInTheDocument()
  })

  it('network-negative: no fetch to /api/ or daemon endpoints during editing', async () => {
    const calls: string[] = []
    const original = window.fetch.bind(window)
    const spy = vi.spyOn(window, 'fetch').mockImplementation((...args) => {
      const url = typeof args[0] === 'string' ? args[0] : args[0] instanceof URL ? args[0].href : (args[0] as Request).url
      calls.push(url)
      return original(...args)
    })
    render(<BrowserLocalCanvasPage store={new IndexedDBStore()} />)
    await waitFor(() => expect(screen.getByTestId('canvas-editor')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /add rectangle/i }))
    await new Promise((resolve) => setTimeout(resolve, 1200))
    const daemonCalls = calls.filter((url) =>
      url.includes('/api/') || url.includes('localhost:3') || url.includes('127.0.0.1'),
    )
    expect(daemonCalls).toHaveLength(0)
    spy.mockRestore()
  })
})
