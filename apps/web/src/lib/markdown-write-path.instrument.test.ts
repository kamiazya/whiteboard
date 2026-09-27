// @vitest-environment jsdom
/**
 * The instrument for how a markdown body's edits reach the store — taken
 * BEFORE the daemon editor's write path changes, so the change is judged by
 * numbers rather than by argument (ADR-0004's addendum: unifying the two
 * write paths "changes when a save lands, and that is judged by measurement").
 *
 * What it drives is a real CodeMirror view over the daemon's sync session,
 * wired the way the daemon page wires it today: every transaction hands the
 * WHOLE text to the session as `set-body`. What it records, per burst of
 * keystrokes:
 *
 * - pushes — how many updates reach the backend (one per debounce today);
 * - bytes — what they weigh on the wire;
 * - whether a comment passage between the two edit sites keeps its mark.
 *
 * Pinned exactly, so a change to the write path moves a number someone has
 * to explain — a count that improves is as loud as one that regresses.
 */

import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import type {
  DocumentBackend,
  DocumentBackendHandlers,
} from '@kamiazya/whiteboard-daemon-client/document-backend-contract'
import { writeMarkdownBody, writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createDocumentSyncSession,
  createGenerationCounters,
  type DocumentSyncSession,
} from './document-sync-session.js'

const HEAD = 'Alpha paragraph opens the note. '
const PASSAGE = 'report on Friday'
const MIDDLE = `Ship the ${PASSAGE}, the draft is not written.`
const TAIL = ' Omega paragraph closes it.'
const BODY = `${HEAD}${MIDDLE}${TAIL}`
const AT = { start: BODY.indexOf(PASSAGE), end: BODY.indexOf(PASSAGE) + PASSAGE.length }

/** A keystroke's gap: well inside the session's 300ms debounce. */
const KEYSTROKE_MS = 40

interface Reading {
  readonly pushes: number
  readonly bytes: number
  readonly markSurvived: boolean
}

function fakeBackend(): DocumentBackend & {
  pushed: Uint8Array[]
  handlers(): DocumentBackendHandlers
} {
  let held: DocumentBackendHandlers | null = null
  const pushed: Uint8Array[] = []
  return {
    pushed,
    handlers: () => {
      if (held === null) throw new Error('not connected')
      return held
    },
    connect(handlers) {
      held = handlers
      handlers.onConnected()
    },
    disconnect() {
      held = null
    },
    pushLocalUpdate(bytes) {
      pushed.push(bytes)
      return Promise.resolve()
    },
    getFile: () => Promise.resolve(null),
    putFile: () => Promise.resolve(),
    sendClientReady() {},
    sendExportResponse() {},
  }
}

async function openSession(): Promise<{
  session: DocumentSyncSession
  backend: ReturnType<typeof fakeBackend>
}> {
  const backend = fakeBackend()
  const session = createDocumentSyncSession(backend, {
    getOptions: () => ({}),
    onStatusChange: () => {},
    onBackendError: () => {},
    onRestoreChange: () => {},
    dispatchIdentityEvent: () => {},
    generations: createGenerationCounters(),
  })
  session.connect()
  const doc = new LoroDoc()
  writeSpatialCanvas(doc, { nodes: [], edges: [] })
  writeMarkdownBody(doc, BODY)
  backend.handlers().onSnapshot(doc.export({ mode: 'snapshot' }))
  session.onChange(session.getCanvas(), {
    kind: 'create-thread',
    thread: {
      id: 't1',
      anchor: { kind: 'text', quote: { exact: PASSAGE }, ...AT },
      status: 'open',
      messages: [{ id: 'm1', body: 'why Friday?' }],
    },
  })
  await vi.advanceTimersByTimeAsync(300)
  expect(session.getThreadMarks().get('t1'), 'the fixture marks its passage').toEqual(AT)
  backend.pushed.length = 0
  return { session, backend }
}

/** The daemon editor today: each transaction's whole text becomes one `set-body`. */
function daemonEditor(session: DocumentSyncSession): EditorView {
  return new EditorView({
    state: EditorState.create({
      doc: BODY,
      extensions: EditorView.updateListener.of((update) => {
        if (!update.docChanged) return
        session.onChange(session.getCanvas(), {
          kind: 'set-body',
          text: update.state.doc.toString(),
        })
      }),
    }),
    parent: document.body,
  })
}

/** Types one character at `at`, then waits one keystroke's gap. */
async function typeAt(view: EditorView, at: (length: number) => number, char: string) {
  const pos = at(view.state.doc.length)
  view.dispatch({ changes: { from: pos, insert: char }, selection: { anchor: pos + 1 } })
  await vi.advanceTimersByTimeAsync(KEYSTROKE_MS)
}

async function measure(burst: (view: EditorView) => Promise<void>): Promise<Reading> {
  const { session, backend } = await openSession()
  const view = daemonEditor(session)
  await burst(view)
  await vi.advanceTimersByTimeAsync(300)
  const range = session.getThreadMarks().get('t1')
  const text = session.getMarkdownBody()
  const reading: Reading = {
    pushes: backend.pushed.length,
    bytes: backend.pushed.reduce((sum, bytes) => sum + bytes.byteLength, 0),
    markSurvived: range !== undefined && text.slice(range.start, range.end) === PASSAGE,
  }
  view.destroy()
  session.dispose()
  return reading
}

const START = () => 0
const END = (length: number) => length

describe('markdown write path — the daemon editor today (set-body)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('ten keystrokes in one place', async () => {
    const reading = await measure(async (view) => {
      for (const char of 'appended!!') await typeAt(view, END, char)
    })
    // One debounced push. The single span is the tail, so the passage keeps
    // its mark.
    expect(reading).toEqual({ pushes: 1, bytes: 95, markSurvived: true })
  })

  it('ten keystrokes alternating between two places', async () => {
    const reading = await measure(async (view) => {
      for (const [i, char] of [...'abcdefghij'].entries()) {
        await typeAt(view, i % 2 === 0 ? START : END, char)
      }
    })
    // Still one push — the debounce collapses the burst to its last whole
    // text — but that text differs from the stored one at BOTH ends, so the
    // one span it becomes runs from the first edit to the last and re-inserts
    // everything between, the passage included. The mark goes with it: the
    // defect this instrument exists to watch leave.
    expect(reading).toEqual({ pushes: 1, bytes: 241, markSurvived: false })
  })
})
