import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render as rtlRender, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { BrowserLocalCanvasPage } from '../pages/BrowserLocalCanvasPage.js'
import { IndexedDBStore } from './browser-local-store.js'
import { installUnloadShim } from './unload-shim.js'
import '../index.css'

async function clearDb(): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase('whiteboard')
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
  })
}

describe('installUnloadShim + real Excalidraw mount (browser)', () => {
  afterEach(() => {
    cleanup()
  })

  // Regression for the shim's central promise: with the shim installed
  // (as main.tsx does before mounting <App />), Excalidraw's own
  // componentDidMount unload-listener registration must never reach the
  // real window.addEventListener as "unload" — only jsdom-independent,
  // real-browser wiring can prove this because jsdom does not enforce a
  // Permissions Policy the way Chrome does.
  it('mounting the real Excalidraw editor never registers a native "unload" listener', async () => {
    await clearDb()
    const nativeAdd = vi.spyOn(window, 'addEventListener')
    const uninstall = installUnloadShim()

    try {
      rtlRender(
        <MemoryRouter initialEntries={['/']}>
          <BrowserLocalCanvasPage store={new IndexedDBStore()} />
        </MemoryRouter>,
      )
      // Wait for Excalidraw's own internal <canvas> to appear, not just our
      // wrapper div — the wrapper renders before Excalidraw's
      // componentDidMount (where it registers "unload") has run.
      await waitFor(
        () => {
          const container = screen.getByTestId('excalidraw-container')
          expect(container.querySelector('canvas')).not.toBeNull()
        },
        { timeout: 5000 },
      )

      const registeredTypes = nativeAdd.mock.calls.map((call) => call[0])
      expect(registeredTypes).not.toContain('unload')
    } finally {
      uninstall()
      nativeAdd.mockRestore()
      await clearDb()
    }
  })
})
