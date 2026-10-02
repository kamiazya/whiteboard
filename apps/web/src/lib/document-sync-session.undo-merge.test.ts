/**
 * Edits committed close together undo as one step, and edits committed far
 * apart undo separately. The window belongs to the session's UndoManager, and
 * it is what makes a drag (many commits in a second) one Undo press rather
 * than dozens, while two unrelated edits a few seconds apart stay two.
 */

import type {
  DocumentBackend,
  DocumentBackendHandlers,
} from '@kamiazya/whiteboard-daemon-client/document-backend-contract'
import { writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  COMMIT_DEBOUNCE_MS,
  createDocumentSyncSession,
  createGenerationCounters,
} from './document-sync-session.js'
import type { EditorCommand } from './spatial/commands.js'
import { applyCommand } from './spatial/commands.js'

const BOARD: SpatialCanvas = {
  nodes: [
    textNode({ id: 'n-a', x: 0, y: 0, width: 100, height: 50, text: 'hello' }),
    textNode({ id: 'n-b', x: 200, y: 0, width: 100, height: 50, text: 'world' }),
  ],
  edges: [],
}

function openedSession() {
  let handlers: DocumentBackendHandlers | null = null
  const backend: DocumentBackend = {
    connect(next) {
      handlers = next
      next.onConnected()
    },
    disconnect() {
      handlers = null
    },
    pushLocalUpdate: () => Promise.resolve(),
    sendClientReady: () => {},
  }
  const session = createDocumentSyncSession(backend, {
    getOptions: () => ({}),
    onStatusChange: vi.fn(),
    onBackendError: vi.fn(),
    onRestoreChange: vi.fn(),
    dispatchIdentityEvent: vi.fn(),
    generations: createGenerationCounters(),
  })
  session.connect()
  const seed = new LoroDoc()
  writeSpatialCanvas(seed, BOARD)
  handlers?.onSnapshot(seed.export({ mode: 'snapshot' }))
  return session
}

/**
 * Commits one move `afterMs` after the previous one's debounce fired, so two
 * commits sit `afterMs` plus the debounce apart: 400ms against the 500ms
 * merge window, then 900ms.
 */
async function move(
  session: ReturnType<typeof openedSession>,
  from: SpatialCanvas,
  command: EditorCommand,
  afterMs: number,
): Promise<SpatialCanvas> {
  await vi.advanceTimersByTimeAsync(afterMs)
  const next = applyCommand(from, command)
  session.onChange(next, command)
  await vi.advanceTimersByTimeAsync(COMMIT_DEBOUNCE_MS)
  return next
}

const MOVE_A: EditorCommand = { kind: 'move-node', id: 'n-a', x: 10, y: 20 }
const MOVE_B: EditorCommand = { kind: 'move-node', id: 'n-b', x: 30, y: 40 }

describe('the session undo stack', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('undoes two edits made within the merge window in one step', async () => {
    const session = openedSession()
    const afterA = await move(session, BOARD, MOVE_A, 0)
    const afterB = await move(session, afterA, MOVE_B, 100)
    expect(session.getCanvas()).toEqual(afterB)

    expect(session.undo()).toBe(true)

    expect(session.getCanvas()).toEqual(BOARD)
    expect(session.canUndo()).toBe(false)
  })

  it('undoes two edits made past the merge window separately', async () => {
    const session = openedSession()
    const afterA = await move(session, BOARD, MOVE_A, 0)
    await move(session, afterA, MOVE_B, 600)

    expect(session.undo()).toBe(true)

    expect(session.getCanvas()).toEqual(afterA)
    expect(session.canUndo()).toBe(true)
  })
})
