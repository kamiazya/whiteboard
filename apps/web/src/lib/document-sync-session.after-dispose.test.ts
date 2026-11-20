/**
 * A session's getters and mutators once it is disposed or its document was
 * replaced. A render in flight, an effect cleanup or a late callback can reach
 * either, and a throw there is a crash.
 *
 * The one rule: a disposed session answers what it held when it was disposed,
 * and a document the session no longer holds answers as one it never had.
 * A call that would change the document is a no-op.
 */

import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  flushMicrotasks,
  markdownSnapshotOf,
  openTestSession,
  snapshotOf,
  typeIntoBody,
} from '../test-utils/document-sync-session.js'
import { watchEngineHandles } from '../test-utils/replica-lease.js'
import { loroTextSync } from './loro-codemirror-sync.js'

afterEach(() => {
  vi.restoreAllMocks()
})

/** Every getter the session publishes: `get*`, the undo flags and the export. */
function gettersOf(session: object): string[] {
  return Object.keys(session).filter(
    (key) => key.startsWith('get') || ['canUndo', 'canRedo', 'exportSnapshot'].includes(key),
  )
}

function answersOf(session: object): Record<string, unknown> {
  const record = session as Record<string, () => unknown>
  return Object.fromEntries(gettersOf(session).map((key) => [key, record[key]?.()]))
}

async function closed(handles: Awaited<ReturnType<typeof watchEngineHandles>>) {
  await vi.waitFor(() => expect(handles.unaccounted()).toEqual([]))
}

describe('a disposed session', () => {
  it('answers every getter with what it held when it was disposed, typed text included', async () => {
    const handles = await watchEngineHandles()
    const s = openTestSession({ snapshot: markdownSnapshotOf('hello') })
    typeIntoBody(s.session, 5, ' world')
    const before = answersOf(s.session)

    s.session.dispose()
    await closed(handles)
    const after = answersOf(s.session)

    expect(gettersOf(s.session).length).toBeGreaterThan(14)
    expect(after.getMarkdownBody).toBe('hello world')
    expect(after.getContentState).toBe(before.getContentState)
    expect(after.exportSnapshot).toBeInstanceOf(Uint8Array)
    expect(after.canUndo).toBe(false)
    expect(after.canRedo).toBe(false)
    const { exportSnapshot: _a, canUndo: _b, canRedo: _c, ...held } = after
    const { exportSnapshot: _d, canUndo: _e, canRedo: _f, ...was } = before
    expect(held).toEqual(was)
  })

  it('answers what it held when nothing was typed, too', async () => {
    const handles = await watchEngineHandles()
    const s = openTestSession({ snapshot: markdownSnapshotOf('hello') })

    s.session.dispose()
    await closed(handles)

    expect(s.session.getMarkdownBody()).toBe('hello')
    expect(s.session.exportSnapshot()).toBeInstanceOf(Uint8Array)
  })

  it('takes no undo while its last commit is still being handed to the keeper', async () => {
    const handles = await watchEngineHandles()
    const s = openTestSession({ snapshot: markdownSnapshotOf('hello') })
    typeIntoBody(s.session, 5, ' world')

    s.session.dispose()

    expect(s.session.undo()).toBe(false)
    await closed(handles)
    expect(s.session.getMarkdownBody()).toBe('hello world')
  })

  it('answers the no-document values for a session that never held one', async () => {
    const s = openTestSession()
    s.session.dispose()

    expect(answersOf(s.session)).toMatchObject({
      getMarkdownBody: '',
      getContentState: null,
      exportSnapshot: null,
      getBodyBinding: null,
      getDocumentName: undefined,
      getCoreFacets: undefined,
    })
  })

  it('takes no undo, redo, edit, lock or body text, and throws on none', async () => {
    const handles = await watchEngineHandles()
    const pushed: Uint8Array[] = []
    const s = openTestSession({
      snapshot: markdownSnapshotOf('hello'),
      push: (update) => {
        pushed.push(update)
        return Promise.resolve()
      },
    })
    const binding = s.session.getBodyBinding()
    if (binding === null) throw new Error('the session holds no document')
    const view = new EditorView({
      state: EditorState.create({
        doc: s.session.getMarkdownBody(),
        extensions: loroTextSync(binding.doc, binding.readText, { commit: binding.commit }),
      }),
      parent: document.body,
    })
    s.session.dispose()
    await closed(handles)
    const persisted = s.persistence.length

    expect(s.session.undo()).toBe(false)
    expect(s.session.redo()).toBe(false)
    expect(() =>
      s.session.onChange(s.session.getCanvas(), { kind: 'move-node', id: 'a', x: 1, y: 1 }),
    ).not.toThrow()
    expect(() => s.session.setNodeLock('a', true)).not.toThrow()
    expect(() => s.session.clearUndo()).not.toThrow()
    expect(() => view.dispatch({ changes: { from: 0, insert: 'late ' } })).not.toThrow()
    await flushMicrotasks()

    expect(pushed).toHaveLength(0)
    expect(s.persistence).toHaveLength(persisted)
    view.destroy()
  })
})

describe('a document a snapshot replaced', () => {
  it('leaves the body a stale editor still holds readable and its writes nowhere', async () => {
    const handles = await watchEngineHandles()
    const pushed: Uint8Array[] = []
    const s = openTestSession({
      snapshot: markdownSnapshotOf('one'),
      push: (update) => {
        pushed.push(update)
        return Promise.resolve()
      },
    })
    const stale = s.session.getBodyBinding()
    if (stale === null) throw new Error('the session holds no document')

    s.handlers().onSnapshot(markdownSnapshotOf('two'))

    expect(s.session.getMarkdownBody()).toBe('two')
    expect(stale.readText(stale.doc)).toBeNull()
    expect(() => stale.doc.body.insert(0, 'x')).not.toThrow()
    expect(() => stale.commit()).not.toThrow()
    expect(() => stale.doc.subscribe(() => {})()).not.toThrow()
    expect(() => stale.doc.body.toString()).not.toThrow()
    await flushMicrotasks()
    expect(pushed).toHaveLength(0)

    s.session.dispose()
    await closed(handles)
  })

  it('answers every getter for the document that replaced it', async () => {
    const s = openTestSession({ snapshot: snapshotOf({ nodes: [], edges: [] }) })
    s.handlers().onSnapshot(markdownSnapshotOf('now'))

    expect(() => answersOf(s.session)).not.toThrow()
    expect(s.session.getMarkdownBody()).toBe('now')
    s.session.dispose()
  })
})
