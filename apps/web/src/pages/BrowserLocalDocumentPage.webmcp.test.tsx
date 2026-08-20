import { act, cleanup, render as rtlRender } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultUserSettings, STORAGE_KEY } from '../lib/user-settings-store.js'
import { webMcpTools } from '../lib/webmcp/tool-definitions.js'
import type { ModelContext, WebMcpToolDescriptor } from '../lib/webmcp/use-browser-tool-registry.js'
import type { DocumentSnapshot } from '../lib/whiteboard-client.js'
import { LocalStoreDouble } from '../test-utils/local-index.js'
import { BrowserLocalDocumentPage } from './BrowserLocalDocumentPage.js'

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

const snap: DocumentSnapshot = {
  documentId: '0AFMSY38DJQW16BGNTZ49EKRX2',
  workspaceId: 'local',
  path: 'untitled',
  name: 'untitled',
  updatedAt: '2026-05-24T00:00:00.000Z',
  kind: 'spatial' as const,
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

describe('BrowserLocalDocumentPage WebMCP wiring', () => {
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

    const store = new LocalStoreDouble()
    await store.setDefaultDocumentId('0AFMSY38DJQW16BGNTZ49EKRX2')
    await store.save(snap)

    await act(async () => {
      render(
        <BrowserLocalDocumentPage
          store={store.index}
          pointer={store.pointer}
          clock={store.clock}
        />,
      )
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

    const store = new LocalStoreDouble()
    await store.setDefaultDocumentId('0AFMSY38DJQW16BGNTZ49EKRX2')
    await store.save(snap)

    await act(async () => {
      render(
        <BrowserLocalDocumentPage
          store={store.index}
          pointer={store.pointer}
          clock={store.clock}
        />,
      )
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(fake.liveNames()).toEqual([])
  })
})
