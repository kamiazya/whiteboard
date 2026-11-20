/**
 * Reads of a session while typed body text is still inside its debounce
 * window. The text is in the editor and in the body the session answers, and
 * not yet committed, so every other read of the document has to describe the
 * body the editor shows without making a commit of its own:
 *
 * - the content state names the state the window's commit will produce, which
 *   is what a picture drawn now is filed under and what the own-edit baseline
 *   is compared with once the push lands;
 * - an export holds the typed text;
 * - a reconnect's resend leaves the text to the commit that is already queued,
 *   and nothing is lost when the window closes.
 */

import {
  contentDigestOfDocument,
  createWorkspaceDocumentAtPath,
  documentContainers,
  resolveWorkspaceDocumentById,
  writeMarkdownBody,
} from '@kamiazya/whiteboard-loro-adapter'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  flushMicrotasks,
  markdownSnapshotOf,
  openTestSession,
  typeIntoBody,
} from '../test-utils/document-sync-session.js'
import { watchEngineHandles } from '../test-utils/replica-lease.js'
import { COMMIT_DEBOUNCE_MS } from './document-sync-session.js'

const DOC = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

function hostedSnapshot(body: string): Uint8Array {
  const doc = new LoroDoc()
  createWorkspaceDocumentAtPath(doc, { path: 'notes', documentId: DOC, kind: 'markdown' })
  writeMarkdownBody(documentContainers(doc, DOC), body)
  doc.commit()
  return doc.export({ mode: 'snapshot' })
}

const KINDS = [
  {
    name: 'a document that is its own record',
    snapshot: () => markdownSnapshotOf('hello'),
    scope: undefined,
    stateOf: (replica: LoroDoc) => contentDigestOfDocument(replica),
  },
  {
    name: 'a document hosted in a workspace record',
    snapshot: () => hostedSnapshot('hello'),
    scope: DOC,
    stateOf: (replica: LoroDoc) => resolveWorkspaceDocumentById(replica, DOC)?.contentDigest,
  },
] as const

describe.each(KINDS)('reads inside the window, over $name', (kind) => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function opened() {
    const pushed: Uint8Array[] = []
    const ownEdits: string[] = []
    const base = kind.snapshot()
    const s = openTestSession({
      snapshot: base,
      push: (update) => {
        pushed.push(update)
        return Promise.resolve()
      },
      deps: {
        ...(kind.scope === undefined ? {} : { contentDocumentId: kind.scope }),
        onOwnEditContentState: (state) => ownEdits.push(state),
      },
    })
    const replica = (): LoroDoc => {
      const doc = new LoroDoc()
      doc.import(base)
      for (const update of pushed) doc.import(update)
      return doc
    }
    const settle = async () => {
      await vi.advanceTimersByTimeAsync(COMMIT_DEBOUNCE_MS * 3)
      await flushMicrotasks()
    }
    return { ...s, pushed, ownEdits, replica, settle }
  }

  it('names the state the window’s commit produces, without committing', async () => {
    const s = opened()
    typeIntoBody(s.session, 5, ' world')
    const inWindow = s.session.getContentState()

    expect(s.pushed).toHaveLength(0)
    expect(inWindow).not.toBeNull()

    await s.settle()

    expect(s.pushed).toHaveLength(1)
    expect(s.session.getContentState()).toBe(inWindow)
    expect(kind.stateOf(s.replica())).toBe(inWindow)
    s.session.dispose()
  })

  it('does not report the person’s own typing as another’s once the window’s own-edit state is announced', async () => {
    const s = opened()
    typeIntoBody(s.session, 5, ' world')
    const inWindow = s.session.getContentState()

    await s.settle()

    expect(s.ownEdits.at(-1)).toBe(inWindow)
    expect(s.ownEdits.at(-1)).toBe(kind.stateOf(s.replica()))
    s.session.dispose()
  })

  it('exports a snapshot that holds the typed text, and makes no commit to do it', () => {
    const s = opened()
    typeIntoBody(s.session, 5, ' world')

    const exported = s.session.exportSnapshot()

    expect(exported).toBeInstanceOf(Uint8Array)
    const replica = new LoroDoc()
    replica.import(exported as Uint8Array)
    const content = kind.scope === undefined ? replica : documentContainers(replica, kind.scope)
    expect(content.getText('body').toString()).toBe('hello world')
    expect(s.pushed).toHaveLength(0)
    expect(s.session.getMarkdownBody()).toBe('hello world')
    s.session.dispose()
  })

  it('gives back the throwaway copy a read inside the window made', async () => {
    const handles = await watchEngineHandles()
    const s = opened()
    typeIntoBody(s.session, 5, ' world')

    s.session.getContentState()
    s.session.exportSnapshot()
    await s.settle()
    s.session.dispose()
    await s.settle()

    expect(handles.forked().length).toBeGreaterThan(0)
    expect(handles.unaccounted()).toEqual([])
  })

  it('loses nothing when the transport reconnects inside the window', async () => {
    const s = opened()
    typeIntoBody(s.session, 5, ' world')

    s.handlers().onConnected()
    await flushMicrotasks()
    await s.settle()

    expect(
      (kind.scope === undefined ? s.replica() : documentContainers(s.replica(), kind.scope))
        .getText('body')
        .toString(),
    ).toBe('hello world')
    s.session.dispose()
  })
})
