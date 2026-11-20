/**
 * What a browser-kept document's editor session writes and announces, seen
 * from outside it: how many saves reach the store, how many updates the other
 * tabs are told of, what a second tab and a reopened page end up holding, what
 * the session's listeners are told, and what undo takes back.
 *
 * It drives the real session over the real `BrowserBackend` and IndexedDB in a
 * real browser, because the cross-tab channel is a browser API. Every
 * assertion reads a public surface — the session, the store, the channel, the
 * window event — so a change to how the session holds the document (a
 * different CRDT handle, buffered writes, another commit cadence) has to keep
 * these answers or say why not.
 *
 * Counts are pinned where a reader depends on one: a save per debounce window
 * is what the persistence report and the other tabs' freshness stand on. What
 * is not pinned is incidental — how many history notifications one undo
 * raises, how many undo steps two windows a few hundred milliseconds apart
 * make (a wall-clock merge window, covered with a controlled clock in
 * `document-sync-session.undo-merge.test.ts`).
 */
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { fc, withDefaults } from '@kamiazya/whiteboard-model/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearWhiteboardDb,
  createNodeCommand,
  persistedMarkdownBody,
  persistedNodeIds,
  registerTestWorkspace,
} from '../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { seedTreeDocument } from '../test-utils/seed-workspace-content.js'
import { BrowserBackend } from './browser-backend.js'
import { getBrowserWorkspaceId } from './browser-workspace-id.js'
import { BrowserWorkspaceRecords } from './browser-workspace-records.js'
import { createDocumentSyncSession, createGenerationCounters } from './document-sync-session.js'
import { DOCUMENT_SYNC_CHANGED_EVENT, dispatchIdentityEvent } from './document-sync-types.js'
import { loroTextSync } from './loro-codemirror-sync.js'
import type { EditorCommand, EditorLeafCommand } from './spatial/commands.js'
import { applyCommand } from './spatial/commands.js'
import { listenToWorkspace, type WorkspaceBroadcast } from './workspace-broadcast.js'

claimIsolatedWhiteboardDb('browser-keeper-writes')

const WAIT = { timeout: 10_000 }
const EMPTY = { nodes: [], edges: [] }

/** Counts the saves a tab's backend asks the store for; the store itself is the real one. */
class CountingDocs extends BrowserWorkspaceRecords {
  saves = 0
  override async save(...args: Parameters<BrowserWorkspaceRecords['save']>) {
    this.saves += 1
    return super.save(...args)
  }
}

/** The window events a tab's session raised, by the identity each tab was given. */
const windowEvents: Array<{ workspaceId: string; path: string }> = []
const onWindowEvent = (event: Event) => {
  windowEvents.push((event as CustomEvent<{ workspaceId: string; path: string }>).detail)
}

const cleanups: Array<() => void> = []

beforeEach(async () => {
  await clearWhiteboardDb()
  await registerTestWorkspace()
  windowEvents.length = 0
  window.addEventListener(DOCUMENT_SYNC_CHANGED_EVENT, onWindowEvent)
})
afterEach(async () => {
  window.removeEventListener(DOCUMENT_SYNC_CHANGED_EVENT, onWindowEvent)
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  await clearWhiteboardDb()
})

/** What one tab's listeners were told, from the moment its page was open. */
async function openTab(
  documentId: string,
  path: string,
  kind: 'markdown' | 'spatial',
  label: string,
) {
  const docs = new CountingDocs()
  const backend = new BrowserBackend({ documentId, path, kind }, docs)
  const persistence: string[] = []
  const origins: Array<'local' | 'external'> = []
  const ownEditStates: string[] = []
  let bodyNotices = 0
  const session = createDocumentSyncSession(backend, {
    getOptions: () => ({ identity: { workspaceId: getBrowserWorkspaceId(), path: label } }),
    onStatusChange: () => {},
    onBackendError: () => {},
    onRestoreChange: () => {},
    dispatchIdentityEvent,
    generations: createGenerationCounters(),
    onPersistenceChange: (state) => persistence.push(state.kind),
    onOwnEditContentState: (state) => ownEditStates.push(state),
    contentDocumentId: documentId,
  })
  let importedMidWindow = 0
  session.subscribe((_canvas, origin) => {
    origins.push(origin)
    if (origin === 'external' && persistence.at(-1) === 'pending') importedMidWindow += 1
  })
  session.subscribeMarkdownBody(() => {
    bodyNotices += 1
  })
  session.connect()
  cleanups.push(() => session.dispose())
  await vi.waitFor(() => expect(session.getBodyBinding()).not.toBeNull(), WAIT)
  // The first publish is the hydration from the stored record.
  origins.length = 0
  return {
    label,
    session,
    docs,
    persistence,
    origins,
    ownEditStates,
    bodyNotices: () => bodyNotices,
    /** Remote imports that landed while the tab's own edit was still waiting to be saved. */
    importedMidWindow: () => importedMidWindow,
    events: () => windowEvents.filter((detail) => detail.path === label).length,
  }
}
type Tab = Awaited<ReturnType<typeof openTab>>

/** A CodeMirror view bound to the tab's body, the way the editor page binds one. */
function editorOn(tab: Tab): EditorView {
  const binding = tab.session.getBodyBinding()
  if (binding === null) throw new Error('the tab holds no document')
  const view = new EditorView({
    state: EditorState.create({
      doc: tab.session.getMarkdownBody(),
      extensions: loroTextSync(binding.doc, binding.readText, { commit: binding.commit }),
    }),
    parent: document.body,
  })
  cleanups.push(() => view.destroy())
  return view
}

/** One keystroke at a time at the end of the text, all inside one debounce window. */
function typeAtEnd(view: EditorView, text: string): void {
  for (const char of text) view.dispatch({ changes: { from: view.state.doc.length, insert: char } })
}

/** Waits for the save an edit made after `persistenceMark` leads to, as the page reports it. */
const savedSince = (tab: Tab, persistenceMark: number) =>
  vi.waitFor(() => {
    expect(tab.persistence.length).toBeGreaterThan(persistenceMark)
    expect(tab.persistence.at(-1)).toBe('saved')
  }, WAIT)

/** The updates tabs have announced on the record's channel, counted once the channel has gone quiet. */
function listenForAnnouncements() {
  const heard: WorkspaceBroadcast[] = []
  const probe = listenToWorkspace(getBrowserWorkspaceId(), (message) => heard.push(message))
  cleanups.push(() => probe.close())
  let sentinels = 0
  return {
    /**
     * A message posted after the saves, from another end, is heard after them:
     * waiting for it is what lets "no more updates than this" be asserted
     * without waiting for time.
     */
    async updates(): Promise<number> {
      const end = listenToWorkspace(getBrowserWorkspaceId(), () => {})
      sentinels += 1
      end.post({ type: 'document-created', path: `sentinel-${sentinels}` })
      end.close()
      await vi.waitFor(
        () => expect(heard.filter((m) => m.type === 'document-created')).toHaveLength(sentinels),
        WAIT,
      )
      return heard.filter((message) => message.type === 'update').length
    },
  }
}

const MARKDOWN = (n: number) => `note-${n}`
let documentCount = 0
async function markdownDocument() {
  documentCount += 1
  const path = MARKDOWN(documentCount)
  const entry = await seedTreeDocument({ path, kind: 'markdown' })
  return { documentId: entry.documentId, path }
}
async function canvasDocument() {
  documentCount += 1
  const path = `canvas-${documentCount}`
  const entry = await seedTreeDocument({ path, kind: 'spatial' })
  return { documentId: entry.documentId, path }
}

describe('typing into a browser-kept markdown body', () => {
  it('is one save and one announcement per debounce window, whatever the keystroke count', async () => {
    const doc = await markdownDocument()
    const channel = listenForAnnouncements()
    const a = await openTab(doc.documentId, doc.path, 'markdown', 'tab-a')
    const b = await openTab(doc.documentId, doc.path, 'markdown', 'tab-b')
    const view = editorOn(a)

    typeAtEnd(view, 'hello world')
    await savedSince(a, 0)

    expect(a.persistence).toEqual(['pending', 'saved'])
    expect(a.docs.saves).toBe(1)
    expect(await channel.updates()).toBe(1)
    expect(await persistedMarkdownBody(doc.documentId)).toBe('hello world')
    await vi.waitFor(() => expect(b.session.getMarkdownBody()).toBe('hello world'), WAIT)
    // The second tab merged what it was told and saved nothing of its own.
    expect(b.docs.saves).toBe(0)
    const reopened = await openTab(doc.documentId, doc.path, 'markdown', 'tab-c')
    expect(reopened.session.getMarkdownBody()).toBe('hello world')
  })

  it('is two saves and two announcements across two windows, and the second tab follows both', async () => {
    const doc = await markdownDocument()
    const channel = listenForAnnouncements()
    const a = await openTab(doc.documentId, doc.path, 'markdown', 'tab-a')
    const b = await openTab(doc.documentId, doc.path, 'markdown', 'tab-b')
    const view = editorOn(a)

    typeAtEnd(view, 'first')
    await savedSince(a, 0)
    typeAtEnd(view, ' second')
    await savedSince(a, 2)

    expect(a.persistence).toEqual(['pending', 'saved', 'pending', 'saved'])
    expect(a.docs.saves).toBe(2)
    expect(await channel.updates()).toBe(2)
    expect(await persistedMarkdownBody(doc.documentId)).toBe('first second')
    await vi.waitFor(() => expect(b.session.getMarkdownBody()).toBe('first second'), WAIT)
  })

  it('tells the listeners once per commit for a local edit and once per import for a remote one', async () => {
    const doc = await markdownDocument()
    const a = await openTab(doc.documentId, doc.path, 'markdown', 'tab-a')
    const b = await openTab(doc.documentId, doc.path, 'markdown', 'tab-b')
    const bodyNoticesBefore = { a: a.bodyNotices(), b: b.bodyNotices() }
    const view = editorOn(a)

    typeAtEnd(view, 'a run of keystrokes')
    await savedSince(a, 0)
    await vi.waitFor(() => expect(b.session.getMarkdownBody()).toBe('a run of keystrokes'), WAIT)

    // The window event the outline listens for: once on the editing tab, once
    // on the tab that received it, each under its own identity.
    expect(a.events()).toBe(1)
    expect(b.events()).toBe(1)
    // Only the person's own edit is announced as seen; a remote one never is.
    expect(a.ownEditStates).toHaveLength(1)
    expect(b.ownEditStates).toEqual([])
    // A body edit publishes no canvas on the editing tab; the receiving tab
    // republishes what it holds as an external change.
    expect(a.origins).toEqual([])
    expect(b.origins).toEqual(['external'])
    expect(a.bodyNotices()).toBeGreaterThan(bodyNoticesBefore.a)
    expect(b.bodyNotices()).toBeGreaterThan(bodyNoticesBefore.b)
  })

  it('is flushed to the store by a dispose that comes before the debounce fires', async () => {
    const doc = await markdownDocument()
    const channel = listenForAnnouncements()
    const a = await openTab(doc.documentId, doc.path, 'markdown', 'tab-a')
    const view = editorOn(a)

    typeAtEnd(view, 'leaving now')
    a.session.dispose()

    await vi.waitFor(async () => {
      expect(await persistedMarkdownBody(doc.documentId)).toBe('leaving now')
    }, WAIT)
    expect(a.docs.saves).toBe(1)
    expect(await channel.updates()).toBe(1)
    // The edit still counts as the person's own, though nobody is left to see it.
    expect(a.ownEditStates).toHaveLength(1)
    // A page that is gone is not told a document changed.
    expect(a.events()).toBe(0)
  })

  it('undoes, and redoes, the run in one step each, saving and announcing each', async () => {
    const doc = await markdownDocument()
    const channel = listenForAnnouncements()
    const a = await openTab(doc.documentId, doc.path, 'markdown', 'tab-a')
    const b = await openTab(doc.documentId, doc.path, 'markdown', 'tab-b')
    const view = editorOn(a)
    expect([a.session.canUndo(), a.session.canRedo()]).toEqual([false, false])

    typeAtEnd(view, 'some words')
    await savedSince(a, 0)
    expect([a.session.canUndo(), a.session.canRedo()]).toEqual([true, false])

    expect(a.session.undo()).toBe(true)

    expect(a.session.getMarkdownBody()).toBe('')
    expect(view.state.doc.toString()).toBe('')
    expect([a.session.canUndo(), a.session.canRedo()]).toEqual([false, true])
    await vi.waitFor(async () => expect(await persistedMarkdownBody(doc.documentId)).toBe(''), WAIT)
    await vi.waitFor(() => expect(b.session.getMarkdownBody()).toBe(''), WAIT)
    expect(a.docs.saves).toBe(2)
    expect(await channel.updates()).toBe(2)

    expect(a.session.redo()).toBe(true)

    expect(a.session.getMarkdownBody()).toBe('some words')
    expect([a.session.canUndo(), a.session.canRedo()]).toEqual([true, false])
    await vi.waitFor(
      async () => expect(await persistedMarkdownBody(doc.documentId)).toBe('some words'),
      WAIT,
    )
    await vi.waitFor(() => expect(b.session.getMarkdownBody()).toBe('some words'), WAIT)
    expect(a.docs.saves).toBe(3)
    expect(await channel.updates()).toBe(3)
  })

  it('drops what undo can redo once a new edit is made', async () => {
    const doc = await markdownDocument()
    const a = await openTab(doc.documentId, doc.path, 'markdown', 'tab-a')
    const view = editorOn(a)
    typeAtEnd(view, 'one')
    await savedSince(a, 0)
    a.session.undo()
    expect(a.session.canRedo()).toBe(true)

    typeAtEnd(view, 'two')
    await savedSince(a, 2)

    expect(a.session.canRedo()).toBe(false)
    expect(a.session.getMarkdownBody()).toBe('two')
  })

  it('keeps an edit another tab saves while it is typed, and undo leaves that edit alone', async () => {
    const doc = await markdownDocument()
    const channel = listenForAnnouncements()
    const a = await openTab(doc.documentId, doc.path, 'markdown', 'tab-a')
    const b = await openTab(doc.documentId, doc.path, 'markdown', 'tab-b')
    const viewA = editorOn(a)
    const viewB = editorOn(b)

    // B's dispose flushes at once, so its save and announcement reach A while
    // A's own keystrokes are still inside their window.
    typeAtEnd(viewA, 'mine')
    typeAtEnd(viewB, ' theirs')
    b.session.dispose()

    await vi.waitFor(() => expect(a.session.getMarkdownBody()).toContain('theirs'), WAIT)
    await savedSince(a, 0)
    const merged = a.session.getMarkdownBody()
    expect(merged).toContain('mine')
    // The editor on the first tab shows the merge, not only the session.
    await vi.waitFor(() => expect(viewA.state.doc.toString()).toBe(merged), WAIT)
    await vi.waitFor(
      async () => expect(await persistedMarkdownBody(doc.documentId)).toBe(merged),
      WAIT,
    )
    // One save of its own on each side, and both reached the channel.
    expect(a.docs.saves).toBe(1)
    expect(b.docs.saves).toBe(1)
    expect(await channel.updates()).toBe(2)
    // A remote edit is not the first tab's to undo: one step, and it was its own.
    expect(a.session.canUndo()).toBe(true)

    expect(a.session.undo()).toBe(true)

    expect(a.session.getMarkdownBody()).toBe(' theirs')
    expect(viewA.state.doc.toString()).toBe(' theirs')
    expect(a.session.canUndo()).toBe(false)
    await vi.waitFor(
      async () => expect(await persistedMarkdownBody(doc.documentId)).toBe(' theirs'),
      WAIT,
    )
  })
})

describe('commanding a browser-kept canvas', () => {
  const create = createNodeCommand('n1', 0, 0) as EditorLeafCommand
  const move: EditorLeafCommand = { kind: 'move-node', id: 'n1', x: 50, y: 60 }
  const created = applyCommand(EMPTY, create)
  const moved = applyCommand(created, move)

  const asTwoCommands = (tab: Tab) => {
    tab.session.onChange(created, create)
    tab.session.onChange(moved, move)
  }
  const asOneBatch = (tab: Tab) => {
    const batch: EditorCommand = { kind: 'batch', commands: [create, move] }
    tab.session.onChange(applyCommand(EMPTY, batch), batch)
  }

  it.each([
    ['two commands', asTwoCommands, ['local', 'local']],
    ['one batch', asOneBatch, ['local']],
  ] as const)('writes %s inside one window as one save and one announcement', async (_how, issue, published) => {
    const doc = await canvasDocument()
    const channel = listenForAnnouncements()
    const a = await openTab(doc.documentId, doc.path, 'spatial', 'tab-a')
    const b = await openTab(doc.documentId, doc.path, 'spatial', 'tab-b')

    issue(a)

    // The editor is handed the edit at once; the write waits for the window.
    expect(a.origins).toEqual(published)
    expect(a.persistence).toEqual(['pending'])
    expect(a.docs.saves).toBe(0)
    await savedSince(a, 0)
    expect(a.persistence).toEqual(['pending', 'saved'])
    expect(a.docs.saves).toBe(1)
    expect(await channel.updates()).toBe(1)
    expect(await persistedNodeIds(doc.documentId)).toEqual(['n1'])
    await vi.waitFor(() => expect(b.session.getCanvas()).toEqual(moved), WAIT)
    expect(b.origins).toEqual(['external'])
    expect(a.events()).toBe(1)
    expect(b.events()).toBe(1)
    expect(a.ownEditStates).toHaveLength(1)
    expect(b.ownEditStates).toEqual([])
    const reopened = await openTab(doc.documentId, doc.path, 'spatial', 'tab-c')
    expect(reopened.session.getCanvas()).toEqual(moved)
  })

  it('writes a command in each of two windows as two saves and two announcements', async () => {
    const doc = await canvasDocument()
    const channel = listenForAnnouncements()
    const a = await openTab(doc.documentId, doc.path, 'spatial', 'tab-a')
    const b = await openTab(doc.documentId, doc.path, 'spatial', 'tab-b')

    a.session.onChange(created, create)
    await savedSince(a, 0)
    a.session.onChange(moved, move)
    await savedSince(a, 2)

    expect(a.docs.saves).toBe(2)
    expect(await channel.updates()).toBe(2)
    await vi.waitFor(() => expect(b.session.getCanvas()).toEqual(moved), WAIT)
    const reopened = await openTab(doc.documentId, doc.path, 'spatial', 'tab-c')
    expect(reopened.session.getCanvas()).toEqual(moved)
  })

  it('undoes and redoes the window as one step each, reaching the store and the other tab', async () => {
    const doc = await canvasDocument()
    const channel = listenForAnnouncements()
    const a = await openTab(doc.documentId, doc.path, 'spatial', 'tab-a')
    const b = await openTab(doc.documentId, doc.path, 'spatial', 'tab-b')
    asTwoCommands(a)
    await savedSince(a, 0)
    await vi.waitFor(() => expect(b.session.getCanvas()).toEqual(moved), WAIT)
    expect([a.session.canUndo(), a.session.canRedo()]).toEqual([true, false])
    a.origins.length = 0

    expect(a.session.undo()).toBe(true)

    expect(a.session.getCanvas()).toEqual(EMPTY)
    expect(a.origins).toEqual(['external'])
    expect([a.session.canUndo(), a.session.canRedo()]).toEqual([false, true])
    await vi.waitFor(async () => expect(await persistedNodeIds(doc.documentId)).toEqual([]), WAIT)
    await vi.waitFor(() => expect(b.session.getCanvas()).toEqual(EMPTY), WAIT)
    expect(a.docs.saves).toBe(2)
    expect(await channel.updates()).toBe(2)

    expect(a.session.redo()).toBe(true)

    expect(a.session.getCanvas()).toEqual(moved)
    expect([a.session.canUndo(), a.session.canRedo()]).toEqual([true, false])
    await vi.waitFor(
      async () => expect(await persistedNodeIds(doc.documentId)).toEqual(['n1']),
      WAIT,
    )
    await vi.waitFor(() => expect(b.session.getCanvas()).toEqual(moved), WAIT)
    expect(a.docs.saves).toBe(3)
    expect(await channel.updates()).toBe(3)
  })

  it('writes nothing for an edit undone inside its window, and reports saved', async () => {
    const doc = await canvasDocument()
    const channel = listenForAnnouncements()
    const a = await openTab(doc.documentId, doc.path, 'spatial', 'tab-a')
    a.session.onChange(created, create)

    expect(a.session.undo()).toBe(true)

    expect(a.session.getCanvas()).toEqual(EMPTY)
    await savedSince(a, 0)
    expect(a.persistence).toEqual(['pending', 'saved'])
    expect(a.docs.saves).toBe(0)
    expect(await channel.updates()).toBe(0)
    expect(await persistedNodeIds(doc.documentId)).toEqual([])
  })
})

describe('two tabs editing one markdown body in any interleaving', () => {
  /** Every given tab has saved what it typed: none is inside a debounce window. */
  const windowsClosed = (tabs: Tab[]) =>
    vi.waitFor(() => {
      for (const tab of tabs) expect(tab.persistence.at(-1) ?? 'saved').toBe('saved')
    }, WAIT)

  type Op =
    | { kind: 'type'; tab: 0 | 1; text: string }
    | { kind: 'undo'; tab: 0 | 1 }
    | { kind: 'redo'; tab: 0 | 1 }
    | { kind: 'pause' }
  const tabArb = fc.constantFrom<0 | 1>(0, 1)
  const opArb: fc.Arbitrary<Op> = fc.oneof(
    {
      weight: 6,
      arbitrary: fc.record({
        kind: fc.constant('type' as const),
        tab: tabArb,
        text: fc.stringMatching(/^[a-z ]{1,5}$/),
      }),
    },
    { weight: 3, arbitrary: fc.record({ kind: fc.constant('undo' as const), tab: tabArb }) },
    { weight: 1, arbitrary: fc.record({ kind: fc.constant('redo' as const), tab: tabArb }) },
    { weight: 1, arbitrary: fc.constant({ kind: 'pause' as const }) },
  )

  it('converges, and the store and a reopened page hold what both tabs hold', async () => {
    const reach = { bothTyped: 0, undone: 0, importedMidWindow: 0 }
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 4, maxLength: 8 }), async (ops) => {
        const doc = await markdownDocument()
        const a = await openTab(doc.documentId, doc.path, 'markdown', 'tab-a')
        const b = await openTab(doc.documentId, doc.path, 'markdown', 'tab-b')
        const tabs = [a, b]
        const views = [editorOn(a), editorOn(b)]
        const typed = new Set<number>()
        let undone = false
        for (const op of ops) {
          if (op.kind === 'type') {
            typeAtEnd(views[op.tab], op.text)
            typed.add(op.tab)
          } else if (op.kind === 'pause') {
            await windowsClosed(tabs)
          } else {
            // Taken once the tab's own window has closed: the in-window case
            // is pinned by example in document-sync-session.body-undo-in-window.test.ts.
            await windowsClosed([tabs[op.tab]])
            if (op.kind === 'undo') undone = tabs[op.tab].session.undo() || undone
            else tabs[op.tab].session.redo()
          }
        }
        if (typed.size === 2) reach.bothTyped += 1
        if (undone) reach.undone += 1

        await vi.waitFor(() => {
          expect(b.session.getMarkdownBody()).toBe(a.session.getMarkdownBody())
        }, WAIT)
        const settled = a.session.getMarkdownBody()
        await vi.waitFor(async () => {
          expect(await persistedMarkdownBody(doc.documentId)).toBe(settled)
        }, WAIT)
        const reopened = await openTab(doc.documentId, doc.path, 'markdown', 'tab-c')
        expect(reopened.session.getMarkdownBody()).toBe(settled)
        expect(a.session.getMarkdownBody()).toBe(settled)
        expect(b.session.getMarkdownBody()).toBe(settled)
        reach.importedMidWindow += a.importedMidWindow() + b.importedMidWindow()
        for (const cleanup of cleanups.splice(0).reverse()) cleanup()
      }),
      withDefaults({ numRuns: 12 }),
    )
    // A generator that rarely had both tabs typing, an undo, or one tab importing the other's edit
    // while its own was unsaved would pass while checking none of them.
    expect(reach.bothTyped).toBeGreaterThan(0)
    expect(reach.undone).toBeGreaterThan(0)
    expect(reach.importedMidWindow).toBeGreaterThan(0)
  })
})
