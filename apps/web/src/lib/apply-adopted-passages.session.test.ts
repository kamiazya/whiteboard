/**
 * Adopting a passage through the session: what `applyAdoptedPassages` cannot
 * show on its own, which is that its rewrite lands in the SAME commit as the
 * statuses it closes. The rewrite itself is `apply-adopted-passages.test.ts`.
 */
import type {
  DocumentBackend,
  DocumentBackendHandlers,
} from '@kamiazya/whiteboard-daemon-client/document-backend-contract'
import {
  writeDocumentKind,
  writeMarkdownBody,
  writeProposal,
} from '@kamiazya/whiteboard-loro-adapter'
import { MARKDOWN_MAX_CHARS, type ProposedChange } from '@kamiazya/whiteboard-model'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDocumentSyncSession, createGenerationCounters } from './document-sync-session.js'
import { applyCommand, type EditorCommand } from './spatial/commands.js'

const BODY = '# Plan\n\nThe plan is to ship on Thursday.\n'

function passageChange(id: string, exact: string, text: string, body = BODY): ProposedChange {
  const start = body.indexOf(exact)
  return {
    id,
    op: 'body.replace',
    status: 'open',
    anchor: { kind: 'text', quote: { exact }, start, end: start + exact.length },
    text,
    assumed: exact,
  }
}

function seededNote(changes: readonly ProposedChange[], body = BODY): Uint8Array {
  const doc = new LoroDoc()
  writeDocumentKind(doc, 'markdown')
  writeMarkdownBody(doc, body)
  writeProposal(doc, { id: 'p1', createdAt: '2026-09-06T00:00:00.000Z', changes: [...changes] })
  return doc.export({ mode: 'snapshot' })
}

function openNote(snapshot: Uint8Array) {
  let handlers: DocumentBackendHandlers | null = null
  const pushes: Uint8Array[] = []
  const backend: DocumentBackend = {
    connect(h) {
      handlers = h
      h.onConnected()
    },
    disconnect() {},
    pushLocalUpdate(bytes) {
      pushes.push(bytes)
      return Promise.resolve()
    },
    sendClientReady() {},
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
  handlers!.onSnapshot(snapshot)
  return { session, pushes }
}

async function decide(
  session: ReturnType<typeof openNote>['session'],
  decision: 'adopted' | 'dismissed',
  changes: readonly ProposedChange[],
): Promise<void> {
  const command: EditorCommand = { kind: 'decide-proposal', proposalId: 'p1', decision, changes }
  session.onChange(applyCommand(session.getCanvas(), command), command)
  await vi.advanceTimersByTimeAsync(300)
}

describe('adopting a proposed passage (ADR-0029 decision 6)', () => {
  // The half a canvas card cannot reach: `body.replace`'s subject is a
  // markdown body, so adopting one has to WRITE that body. Stamping the
  // status alone leaves the person looking at an "adopted" change and an
  // unchanged document, which is the worst of the three possible states.
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('rewrites the passage and closes the change', async () => {
    const change = passageChange('c1', 'Thursday', 'Friday')
    const { session } = openNote(seededNote([change]))

    await decide(session, 'adopted', [change])

    expect(session.getMarkdownBody()).toBe('# Plan\n\nThe plan is to ship on Friday.\n')
    expect(session.getProposals()[0]?.changes[0]?.status).toBe('adopted')
  })

  it('lands as ONE update payload, because a decision is one act', async () => {
    const changes = [
      passageChange('c1', 'Thursday', 'Friday'),
      passageChange('c2', '# Plan', '# The plan'),
    ]
    const { session, pushes } = openNote(seededNote(changes))

    await decide(session, 'adopted', changes)

    // Two statuses, the canvas and the body are four writes of one act. A
    // commit each would ship four independent deltas, so a transport that
    // died between them would leave the change marked adopted with the words
    // it promised to rewrite still on the page.
    expect(pushes).toHaveLength(1)
    expect(session.getMarkdownBody()).toBe('# The plan\n\nThe plan is to ship on Friday.\n')
  })

  it('leaves the body alone when the passage is dismissed', async () => {
    const change = passageChange('c1', 'Thursday', 'Friday')
    const { session } = openNote(seededNote([change]))

    await decide(session, 'dismissed', [change])

    expect(session.getMarkdownBody()).toBe(BODY)
    expect(session.getProposals()[0]?.changes[0]?.status).toBe('dismissed')
  })

  it('writes nothing and leaves the change open when adopting passes the limit', async () => {
    // A body the keepers would refuse is refused here instead, and whole: a
    // change stamped adopted over words still on the page is the state the
    // single commit exists to rule out.
    const body = `tail-${'x'.repeat(MARKDOWN_MAX_CHARS - 'tail-'.length)}`
    const change = passageChange('c1', 'tail', 'tails', body)
    const { session, pushes } = openNote(seededNote([change], body))

    await decide(session, 'adopted', [change])

    expect(session.getMarkdownBody()).toBe(body)
    expect(session.getProposals()[0]?.changes[0]?.status).toBe('open')
    expect(pushes).toEqual([])
  })

  it('closes the change for a passage that is gone, writing nothing into the body', async () => {
    const gone = passageChange('c1', 'Thursday', 'Friday')
    const { session } = openNote(seededNote([gone], 'The plan changed entirely.\n'))

    await decide(session, 'adopted', [gone])

    // The person answered, and an orphaned passage that stayed open would ask
    // them again every time they opened the note.
    expect(session.getMarkdownBody()).toBe('The plan changed entirely.\n')
    expect(session.getProposals()[0]?.changes[0]?.status).toBe('adopted')
  })
})
