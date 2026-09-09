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

import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
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
