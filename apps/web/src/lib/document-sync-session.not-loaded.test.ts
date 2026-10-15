/**
 * A session whose backend has not delivered the document yet. Its edits
 * have no document to land in, so they are refused rather than published:
 * a stroke shown on the empty placeholder and then never written reads as
 * saved work until the page reloads into the real document without it.
 */
import type {
  DocumentBackend,
  DocumentBackendHandlers,
} from '@kamiazya/whiteboard-daemon-client/document-backend-contract'
import { writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it, vi } from 'vitest'
import type { BrowserPersistenceState } from './browser-persistence-state.js'
import { createDocumentSyncSession, createGenerationCounters } from './document-sync-session.js'
import { applyCommand, type EditorCommand } from './spatial/commands.js'

const drawn = textNode({ id: 'n-new', x: 0, y: 0, width: 100, height: 40, text: 'drawn' })
const create: EditorCommand = { kind: 'create-node', node: drawn }

function openUnloaded() {
  let handlers: DocumentBackendHandlers | null = null
  const pushLocalUpdate = vi.fn(() => Promise.resolve())
  const backend = {
    connect(h: DocumentBackendHandlers) {
      handlers = h
    },
    disconnect() {},
    pushLocalUpdate,
    sendClientReady() {},
  } as unknown as DocumentBackend
  const persistence: BrowserPersistenceState['kind'][] = []
  const session = createDocumentSyncSession(backend, {
    getOptions: () => ({}),
    onStatusChange: () => {},
    onBackendError: () => {},
    onRestoreChange: () => {},
    dispatchIdentityEvent: () => {},
    generations: createGenerationCounters(),
    onPersistenceChange: (state) => persistence.push(state.kind),
  })
  const published: SpatialCanvas[] = []
  session.subscribe((next) => published.push(next))
  session.connect()
  return { session, published, persistence, pushLocalUpdate, handlers: () => handlers! }
}

describe('a session with no document yet', () => {
  it('refuses an edit rather than showing ink it cannot write', () => {
    const s = openUnloaded()
    const empty = s.session.getCanvas()

    s.session.onChange(applyCommand(empty, create), create)

    expect(s.published).toEqual([])
    expect(s.session.getCanvas()).toEqual(empty)
    expect(s.persistence).not.toContain('pending')
    expect(s.pushLocalUpdate).not.toHaveBeenCalled()
  })

  it('takes edits once the document has arrived', () => {
    const s = openUnloaded()
    const doc = new LoroDoc()
    writeSpatialCanvas(doc, { nodes: [], edges: [] })
    s.handlers().onSnapshot(doc.export({ mode: 'snapshot' }))
    const loaded = s.session.getCanvas()

    s.session.onChange(applyCommand(loaded, create), create)

    expect(s.session.getCanvas().nodes.map((n) => n.id)).toEqual(['n-new'])
  })
})
