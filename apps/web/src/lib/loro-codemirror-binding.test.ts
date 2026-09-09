// @vitest-environment jsdom
/**
 * What `patches/loro-codemirror@0.3.3.patch` is for.
 *
 * `LoroSyncPluginValue` arms an `isInitDispatch` flag so that its own seeding
 * dispatch is not echoed back into the container as a local edit. Upstream
 * arms it BEFORE the early return that skips the seeding when the view and
 * the container already agree — which is every empty new note — so the flag
 * is left standing with no dispatch to pair with, and `update()` consumes it
 * on the user's first keystroke instead.
 *
 * The consequence is not a lost character. The editor is then one character
 * ahead of the container, so the second keystroke asks a length-0 `LoroText`
 * to insert at position 1 and loro throws; the throw happens inside a
 * `ViewPlugin`, which `@codemirror/view` answers by disabling the plugin for
 * the life of the view. Every keystroke after that reaches CodeMirror and
 * nothing else — no delta, no commit, no save — so it presents as saving
 * having broken rather than as a crash.
 *
 * Both cases below, because a fix that simply never armed the flag would pass
 * the first one and silently reintroduce the echo the flag exists to stop.
 */

import { history, undo } from '@codemirror/commands'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import {
  createWorkspaceDocumentAtPath,
  documentContainers,
} from '@kamiazya/whiteboard-loro-adapter'
import { LoroSyncPlugin } from 'loro-codemirror'
import { LoroDoc } from 'loro-crdt'
import { afterEach, describe, expect, it } from 'vitest'

const views: EditorView[] = []

afterEach(() => {
  for (const view of views.splice(0)) view.destroy()
})

function bind(doc: LoroDoc, initial = ''): EditorView {
  const view = new EditorView({
    state: EditorState.create({
      doc: initial,
      extensions: [LoroSyncPlugin(doc, (d) => d.getText('body'))],
    }),
    parent: document.body,
  })
  views.push(view)
  return view
}

/** The plugin seeds in a microtask; let it run before typing. */
async function settleInit(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('the CodeMirror binding over a Loro text container', () => {
  it('carries the FIRST keystroke into the container, not only the ones after it', async () => {
    const doc = new LoroDoc()
    const view = bind(doc)
    await settleInit()

    view.dispatch({ changes: { from: 0, insert: '#' } })

    expect(doc.getText('body').toString()).toBe('#')
  })

  // The failure the swallowed keystroke actually produced: the container is
  // a character behind, so the next edit addresses a position it does not
  // have. Unpatched this throws inside the ViewPlugin and the binding is
  // disabled for the rest of the view's life.
  it('keeps typing after the first character, rather than addressing a position the container lacks', async () => {
    const doc = new LoroDoc()
    const view = bind(doc)
    await settleInit()

    view.dispatch({ changes: { from: 0, insert: '#' } })
    view.dispatch({ changes: { from: 1, insert: ' Notes' } })

    expect(doc.getText('body').toString()).toBe('# Notes')
    expect(view.state.doc.toString()).toBe('# Notes')
  })

  // The property the flag exists for, and the reason the fix moves it rather
  // than deleting it: seeding the view from a container that already holds
  // text must not come back as a local edit doubling the content.
  it('does not echo its own seeding back into the container', async () => {
    const doc = new LoroDoc()
    doc.getText('body').insert(0, 'already written')
    doc.commit()
    const view = bind(doc)
    await settleInit()

    expect(doc.getText('body').toString()).toBe('already written')
    expect(view.state.doc.toString()).toBe('already written')
  })
})

/**
 * The other half of the binding, and the one no fixture had modelled: content
 * arriving from anywhere OTHER than this editor.
 *
 * Both cases below are shaped like the product rather than like a unit test,
 * because the shape is what decides them. The body is a container on a
 * WORKSPACE document's tree node, not a root container — so any batch that
 * reaches it also carries events for the tree, the node meta and whatever
 * else moved. A flat root-level fixture produces a single text event and
 * passes over both defects; measured, the realistic one orders its events
 * `map,map,text`.
 */
describe('content that reaches the container from outside this editor', () => {
  const DOC_ID = '01M0P7D8CDZ5TP3C8ZYM8G275W'
  const workspaceBody = (d: LoroDoc) => documentContainers(d, DOC_ID).getText('body')

  function workspaceDoc(body: string): LoroDoc {
    const doc = new LoroDoc()
    createWorkspaceDocumentAtPath(doc, { path: 'notes/plan', documentId: DOC_ID, kind: 'markdown' })
    workspaceBody(doc).insert(0, body)
    doc.commit()
    return doc
  }

  function bindWorkspace(doc: LoroDoc): EditorView {
    const view = new EditorView({
      state: EditorState.create({
        doc: '',
        extensions: [LoroSyncPlugin(doc, workspaceBody)],
      }),
      parent: document.body,
    })
    views.push(view)
    return view
  }

  // The daemon-propagation route: `cacheDaemonWorkspace` imports the daemon's
  // bytes into the very workspace document this binding holds. The import
  // batch carries the tree and node-meta events alongside the body's, and the
  // body's is not first.
  it('follows an import whose batch also touches other containers', async () => {
    const doc = workspaceDoc('hello')
    const view = bindWorkspace(doc)
    await settleInit()

    const peer = new LoroDoc()
    peer.import(doc.export({ mode: 'snapshot' }))
    documentContainers(peer, DOC_ID).getMap('core').set('type', 'note')
    peer.getMap('names').set('notes/plan', 'Plan')
    workspaceBody(peer).insert(5, ' world')
    peer.commit()
    doc.import(peer.export({ mode: 'update' }))
    await settleInit()

    expect(workspaceBody(doc).toString()).toBe('hello world')
    expect(view.state.doc.toString()).toBe('hello world')
  })

  // The restore route: `writeWorkspaceDocumentContent` splices the container
  // in place, which is a LOCAL change — so a binding that only listens for
  // remote ones leaves the editor showing the pre-restore draft while the
  // document holds the restored one.
  it('follows a local write made to the container from elsewhere', async () => {
    const doc = workspaceDoc('current draft')
    const view = bindWorkspace(doc)
    await settleInit()

    const text = workspaceBody(doc)
    text.delete(0, text.length)
    text.insert(0, 'restored from a version')
    doc.commit()
    await settleInit()

    expect(view.state.doc.toString()).toBe('restored from a version')
  })

  // What makes the two above safe. This editor's own writes come back through
  // the same subscription, and a binding that replayed the batch's deltas
  // would duplicate every keystroke — so the reconcile diffs against the
  // view's ACTUAL text instead, and a batch this editor caused has nothing
  // left to apply.
  //
  // Measured, not assumed: the early `current === next` return is an
  // optimisation and not the thing that holds this. Removing it leaves the
  // test green, because the diff of two equal strings is an empty splice.
  // It stays because a workspace document publishes an event for every
  // document in it, and most of them are not this body.
  it('does not re-apply the edits this editor itself made', async () => {
    const doc = workspaceDoc('')
    const view = bindWorkspace(doc)
    await settleInit()

    view.dispatch({ changes: { from: 0, insert: 'typed here' } })
    await settleInit()

    expect(workspaceBody(doc).toString()).toBe('typed here')
    expect(view.state.doc.toString()).toBe('typed here')
  })

  // Caret preservation is why the reconcile is a minimal splice rather than a
  // whole-document replace: a replace collapses the selection to the end.
  it('keeps the caret where it was when text arrives before it', async () => {
    const doc = workspaceDoc('alpha omega')
    const view = bindWorkspace(doc)
    await settleInit()
    view.dispatch({ selection: { anchor: 6 } })

    const peer = new LoroDoc()
    peer.import(doc.export({ mode: 'snapshot' }))
    workspaceBody(peer).insert(0, 'REMOTE ')
    peer.commit()
    doc.import(peer.export({ mode: 'update' }))
    await settleInit()

    expect(view.state.doc.toString()).toBe('REMOTE alpha omega')
    expect(view.state.selection.main.anchor).toBe(13)
  })
})

/**
 * Undo must take back what THIS user did, and nothing else.
 *
 * `SourcePane` installs CodeMirror's own `history()`, which records every
 * transaction it is not told to skip — including the ones this binding
 * dispatches to bring in a peer's change or a restore. `history()` then maps
 * its stored inverse through every later change, so one Ctrl-Z after a
 * merge does not simply undo the user's keystroke: measured, it emptied the
 * document outright, and the binding wrote that deletion straight back into
 * the CRDT, so the peer lost their text too.
 *
 * The binding's dispatches therefore carry `Transaction.addToHistory.of(false)`.
 * That is the collaborative-editing idiom, and it is why this stays on
 * CodeMirror's history rather than swapping in `LoroUndoPlugin` — the
 * document's own undo already belongs to the sync session's `UndoManager`,
 * and a second CRDT-level undo stack beside it would be two owners for one
 * question.
 */
describe('undo over content that arrived from elsewhere', () => {
  const DOC_ID = '01M0P7D8CDZ5TP3C8ZYM8G275W'
  const workspaceBody = (d: LoroDoc) => documentContainers(d, DOC_ID).getText('body')

  function bindWithHistory(doc: LoroDoc): EditorView {
    // The same order SourcePane uses: history() among the built-ins, the host
    // binding appended last.
    const view = new EditorView({
      state: EditorState.create({
        doc: '',
        extensions: [history(), LoroSyncPlugin(doc, workspaceBody)],
      }),
      parent: document.body,
    })
    views.push(view)
    return view
  }

  function emptyWorkspaceDoc(): LoroDoc {
    const doc = new LoroDoc()
    createWorkspaceDocumentAtPath(doc, { path: 'notes/plan', documentId: DOC_ID, kind: 'markdown' })
    doc.commit()
    return doc
  }

  it("takes back this user's edit and leaves a peer's change standing", async () => {
    const doc = emptyWorkspaceDoc()
    const view = bindWithHistory(doc)
    await settleInit()

    view.dispatch({ changes: { from: 0, insert: 'mine' } })
    await settleInit()

    const peer = new LoroDoc()
    peer.import(doc.export({ mode: 'snapshot' }))
    workspaceBody(peer).insert(4, ' THEIRS')
    peer.commit()
    doc.import(peer.export({ mode: 'update' }))
    await settleInit()
    expect(workspaceBody(doc).toString()).toBe('mine THEIRS')

    undo(view)
    await settleInit()

    // Only this user's four characters go. The peer's text is still there,
    // and — because the binding writes the undo back — still there in the
    // document the peer will read.
    expect(view.state.doc.toString()).toBe(' THEIRS')
    expect(workspaceBody(doc).toString()).toBe(' THEIRS')
  })

  // The seeding dispatch is not an edit either. Undo on a freshly opened
  // document that the user has not touched must have nothing to take back.
  it('has nothing to undo on a document this user has not edited', async () => {
    const doc = emptyWorkspaceDoc()
    workspaceBody(doc).insert(0, 'written by somebody else')
    doc.commit()
    const view = bindWithHistory(doc)
    await settleInit()
    expect(view.state.doc.toString()).toBe('written by somebody else')

    undo(view)
    await settleInit()

    expect(view.state.doc.toString()).toBe('written by somebody else')
    expect(workspaceBody(doc).toString()).toBe('written by somebody else')
  })
})
