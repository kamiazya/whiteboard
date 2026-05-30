import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, cleanup } from '@testing-library/react'
import { MemoryStore } from '../lib/browser-local-store.js'
import type { BrowserLocalStore } from '../lib/browser-local-store.js'
import { BrowserLocalCanvasPage } from './BrowserLocalCanvasPage.js'
import type { CanvasSnapshot } from '../lib/whiteboard-client.js'

const snap: CanvasSnapshot = {
  id: 'c1',
  name: 'untitled',
  scene: { elements: [] },
  updatedAt: '2026-05-24T00:00:00.000Z',
}

describe('BrowserLocalCanvasPage', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => { cleanup(); vi.useRealTimers() })

  it('renders loading state before canvas is loaded', () => {
    const store = new MemoryStore()
    render(<BrowserLocalCanvasPage store={store} />)
    expect(screen.getByRole('status')).toBeTruthy()
  })

  it('renders editor view once canvas is loaded', async () => {
    const store = new MemoryStore()
    await store.setDefaultCanvasId('c1')
    await store.save(snap)
    await act(async () => {
      render(<BrowserLocalCanvasPage store={store} />)
    })
    expect(screen.getByRole('main')).toBeTruthy()
  })

  it('renders load-degraded banner when store load fails', async () => {
    const base = new MemoryStore()
    const failingStore: BrowserLocalStore = {
      getDefaultCanvasId: async () => 'c1',
      setDefaultCanvasId: base.setDefaultCanvasId.bind(base),
      load: async () => ({ kind: 'corrupted' }),
      save: base.save.bind(base),
      del: base.del.bind(base),
      generateId: base.generateId.bind(base),
    }
    await act(async () => {
      render(<BrowserLocalCanvasPage store={failingStore} />)
    })
    expect(screen.getByRole('alert')).toBeTruthy()
    // Generic safe copy — no raw error
    expect(screen.getByRole('alert').textContent).not.toMatch(/\btoken\b|\bAuthorization\b|\bBearer\b/i)
  })

  it('offers a Start fresh recovery action in the load-degraded banner', async () => {
    const base = new MemoryStore()
    const failingStore: BrowserLocalStore = {
      getDefaultCanvasId: async () => 'c1',
      setDefaultCanvasId: base.setDefaultCanvasId.bind(base),
      load: async () => ({ kind: 'corrupted' }),
      save: base.save.bind(base),
      del: base.del.bind(base),
      generateId: base.generateId.bind(base),
    }
    await act(async () => {
      render(<BrowserLocalCanvasPage store={failingStore} />)
    })
    // The degraded banner must not be a dead end: a recovery action mints a fresh canvas.
    const startFresh = screen.getByRole('button', { name: /start fresh/i })
    await act(async () => {
      startFresh.click()
      await vi.runAllTimersAsync()
    })
    expect(screen.getByRole('main')).toBeTruthy()
  })

  it('renders cleanup-completed view after delete button click', async () => {
    const store = new MemoryStore()
    await store.setDefaultCanvasId('c1')
    await store.save(snap)
    await act(async () => {
      render(<BrowserLocalCanvasPage store={store} />)
    })
    // After act, load is complete and editing state is rendered — button must exist
    const cleanupBtn = screen.getByRole('button', { name: /delete/i })
    await act(async () => {
      cleanupBtn.click()
      await vi.runAllTimersAsync()
    })
    expect(screen.getByTestId('cleanup-completed')).toBeTruthy()
  })

  it('makes no network requests during load or cleanup', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('', { status: 200 }),
    )
    const store = new MemoryStore()
    await store.setDefaultCanvasId('c1')
    await store.save(snap)
    await act(async () => {
      render(<BrowserLocalCanvasPage store={store} />)
    })
    const deleteBtn = screen.getByRole('button', { name: /delete/i })
    await act(async () => {
      deleteBtn.click()
      await vi.runAllTimersAsync()
    })
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })
})
