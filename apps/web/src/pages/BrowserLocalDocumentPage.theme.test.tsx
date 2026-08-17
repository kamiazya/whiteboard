/**
 * Confirms the page actually threads its resolved theme into `SpatialEditor`
 * — the `theme` prop is optional, so a page that forgets to pass it still
 * compiles, silently reproducing the dark-mode-invisible-chrome bug this
 * wiring exists to fix.
 */
import { act, cleanup, render as rtlRender, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { forwardRef } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryStore } from '../lib/browser-local-store.js'
import type { DocumentSnapshot } from '../lib/whiteboard-client.js'

const capturedThemes: unknown[] = []

vi.mock('../components/spatial-editor/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../components/spatial-editor/index.js')>()
  const CapturingSpatialEditor = forwardRef<unknown, Parameters<typeof actual.SpatialEditor>[0]>(
    (props, ref) => {
      capturedThemes.push(props.theme)
      return <actual.SpatialEditor {...props} ref={ref as any} />
    },
  )
  return { ...actual, SpatialEditor: CapturingSpatialEditor }
})

vi.mock('../lib/browser-local-backend.js', () => ({
  BrowserLocalBackend: class {
    connect(handlers: { onConnected: () => void; onSnapshot: (b: Uint8Array) => void }) {
      handlers.onConnected()
      const { LoroDoc } = require('loro-crdt') as typeof import('loro-crdt')
      handlers.onSnapshot(new LoroDoc().export({ mode: 'snapshot' }))
    }
    disconnect() {}
    pushLocalUpdate() {
      return Promise.resolve()
    }
    getFile() {
      return Promise.resolve(null)
    }
    putFile() {
      return Promise.resolve()
    }
    sendClientReady() {}
    sendExportResponse() {}
  },
}))

const { BrowserLocalDocumentPage } = await import('./BrowserLocalDocumentPage.js')
const { THEME_STORAGE_KEY } = await import('../hooks/useThemeMode.js')

function render(ui: ReactElement) {
  return rtlRender(<MemoryRouter initialEntries={['/']}>{ui}</MemoryRouter>)
}

const snap: DocumentSnapshot = {
  id: 'c1',
  name: 'untitled',
  updatedAt: '2026-05-24T00:00:00.000Z',
  kind: 'spatial' as const,
}

describe('BrowserLocalDocumentPage theme wiring', () => {
  beforeEach(() => {
    capturedThemes.length = 0
    window.localStorage.clear()
  })
  afterEach(() => {
    cleanup()
    window.localStorage.clear()
  })

  it('threads resolvedTheme=dark into SpatialEditor when the stored preference is dark', async () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark')
    const store = new MemoryStore()
    await store.setDefaultDocumentId('c1')
    await store.save(snap)
    await act(async () => {
      render(<BrowserLocalDocumentPage store={store} />)
    })
    expect(screen.getByTestId('spatial-editor-container')).toBeTruthy()
    expect(capturedThemes).toContain('dark')
  })

  it('threads resolvedTheme=light into SpatialEditor when the stored preference is light', async () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'light')
    const store = new MemoryStore()
    await store.setDefaultDocumentId('c1')
    await store.save(snap)
    await act(async () => {
      render(<BrowserLocalDocumentPage store={store} />)
    })
    expect(screen.getByTestId('spatial-editor-container')).toBeTruthy()
    expect(capturedThemes).toContain('light')
    expect(capturedThemes).not.toContain('dark')
  })
})
