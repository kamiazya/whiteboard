import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { MemoryStore } from '../lib/browser-local-store.js'
import { BrowserLocalIndexPage } from '../pages/BrowserLocalIndexPage.js'
import '../index.css'
import { resolveDocAssetPath } from './_helpers.js'

// Generates docs/assets/browser-local-list.png — the browser-local canvas
// list that '/' lands on, used by the getting-started tutorial.

const NOW = new Date('2026-05-02T12:00:00.000Z')

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(NOW)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('docs snapshot: browser-local canvas list', () => {
  it('captures the list with a markdown note and a spatial pair', async () => {
    const store = new MemoryStore()
    // 1d, 2d, 5d ago relative to NOW so the labels stay stable.
    await store.save({
      id: 'id-a',
      name: 'Meeting notes',
      updatedAt: '2026-05-01T12:00:00.000Z',
      kind: 'markdown',
    })
    await store.save({
      id: 'id-b',
      name: 'Trip plan',
      updatedAt: '2026-04-30T12:00:00.000Z',
      kind: 'spatial',
    })
    await store.save({
      id: 'id-c',
      name: 'Sketches',
      updatedAt: '2026-04-27T12:00:00.000Z',
      kind: 'spatial',
    })

    render(
      <div style={{ height: '100vh', background: 'white' }}>
        <BrowserLocalIndexPage store={store} onOpenCanvas={() => {}} />
      </div>,
    )

    await waitFor(() => {
      if (document.querySelectorAll('[data-testid="canvas-list-card"]').length !== 3) {
        throw new Error('cards not settled')
      }
    })

    await page.screenshot({ path: resolveDocAssetPath('browser-local-list.png') })
  })
})
