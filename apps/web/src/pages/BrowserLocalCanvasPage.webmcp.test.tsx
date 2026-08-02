import { act, cleanup, render as rtlRender } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryStore } from '../lib/browser-local-store.js'
import { defaultUserSettings, STORAGE_KEY } from '../lib/user-settings-store.js'
import { webMcpTools } from '../lib/webmcp/tool-definitions.js'
import type { ModelContext, WebMcpToolDescriptor } from '../lib/webmcp/use-browser-tool-registry.js'
import type { CanvasSnapshot } from '../lib/whiteboard-client.js'
import { BrowserLocalCanvasPage } from './BrowserLocalCanvasPage.js'

function render(ui: ReactElement) {
  return rtlRender(<MemoryRouter initialEntries={['/']}>{ui}</MemoryRouter>)
}

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

const snap: CanvasSnapshot = {
  id: 'c1',
  name: 'untitled',
  updatedAt: '2026-05-24T00:00:00.000Z',
}

function createFakeModelContext(): ModelContext & { liveNames(): string[] } {
  const live = new Map<string, AbortSignal>()
  return {
    liveNames: () => [...live.keys()],
    registerTool: async (descriptor: WebMcpToolDescriptor, options: { signal: AbortSignal }) => {
      await Promise.resolve()
      if (options.signal.aborted) return
      live.set(descriptor.name, options.signal)
      options.signal.addEventListener('abort', () => live.delete(descriptor.name))
    },
  }
}

describe('BrowserLocalCanvasPage WebMCP wiring', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    localStorage.clear()
    delete (document as { modelContext?: unknown }).modelContext
  })

  it('registers every read-only tool, keyed on the loaded canvas id, when document.modelContext is present', async () => {
    const fake = createFakeModelContext()
    document.modelContext = fake

    const store = new MemoryStore()
    await store.setDefaultCanvasId('c1')
    await store.save(snap)

    await act(async () => {
      render(<BrowserLocalCanvasPage store={store} />)
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(fake.liveNames().sort()).toEqual(webMcpTools.map((tool) => tool.name).sort())
  })

  it('registers no tools when capabilities.webMcpEnabled is persisted as false', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        ...defaultUserSettings(),
        capabilities: { webMcpEnabled: false },
      }),
    )
    const fake = createFakeModelContext()
    document.modelContext = fake

    const store = new MemoryStore()
    await store.setDefaultCanvasId('c1')
    await store.save(snap)

    await act(async () => {
      render(<BrowserLocalCanvasPage store={store} />)
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(fake.liveNames()).toEqual([])
  })
})
