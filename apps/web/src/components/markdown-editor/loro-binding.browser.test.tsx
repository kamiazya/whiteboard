/**
 * CRDT binding for the markdown source pane (loro-codemirror), the wiring a
 * composition root supplies through MarkdownEditor's `sourceExtensions`.
 * Real browser: caret behavior across remote edits is exactly what jsdom
 * cannot fake. What these pin:
 *
 * - typing lands in the Loro 'body' text container as real deltas,
 * - a REMOTE edit (an import from another peer) merges into the visible
 *   editor without going through the controlled `value` at all, and the
 *   local caret moves by exactly the inserted length — the precision the
 *   minimalChange reconcile path can only approximate.
 */
import { cleanup, render } from '@testing-library/react'
import { LoroSyncPlugin } from 'loro-codemirror'
import { Loro, type LoroDoc } from 'loro-crdt'
import { afterEach, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { expectCodeMirrorPluginCrash } from '../../test-utils/browser-setup.js'
import { focusEditable } from '../../test-utils/focus-editable.js'
import { MarkdownEditor } from './MarkdownEditor.js'

afterEach(cleanup)

function mountBound(initialBody: string) {
  const doc = new Loro()
  doc.getText('body').insert(0, initialBody)
  doc.commit()
  const binding = [LoroSyncPlugin(doc as LoroDoc, (d) => d.getText('body'))]
  const utils = render(
    <div style={{ width: 800, height: 300 }}>
      <MarkdownEditor
        initialViewMode="write"
        value={initialBody}
        onChange={() => {}}
        previewDebounceMs={0}
        sourceExtensions={binding}
      />
    </div>,
  )
  return { doc, ...utils }
}

it('typing in the editor lands in the Loro body container', async () => {
  const { doc, container } = mountBound('hello ')
  await focusEditable(() => container.querySelector('.cm-content'))
  await userEvent.keyboard('{End}world')
  await vi.waitFor(() => {
    expect(doc.getText('body').toString()).toBe('hello world')
  })
})

it('a remote edit merges into the editor and shifts the caret exactly', async () => {
  const { doc, container } = mountBound('alpha omega')
  await focusEditable(() => container.querySelector('.cm-content'))
  // Park the caret between the words: after "alpha " (position 6).
  await userEvent.keyboard(
    '{Home}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}',
  )

  // A second peer prepends text and its update is imported — the transport
  // this simulates does not matter (SharedWorker, websocket, file import).
  const remote = new Loro()
  remote.import(doc.export({ mode: 'snapshot' }))
  remote.getText('body').insert(0, 'REMOTE ')
  remote.commit()
  doc.import(remote.export({ mode: 'update' }))

  await vi.waitFor(() => {
    const view = container.querySelector('.cm-content') as HTMLElement
    expect(view.textContent).toContain('REMOTE alpha omega')
  })

  // The caret sat at 6 ("alpha |omega" minus the remote prefix); a 7-char
  // remote insert BEFORE it must land it at 13 — still between the words.
  await userEvent.keyboard('X')
  await vi.waitFor(() => {
    expect(doc.getText('body').toString()).toBe('REMOTE alpha Xomega')
  })
})

/**
 * The container a binding addresses is resolved LIVE, and a resolver that
 * answers with a different container under an already-mounted view kills the
 * binding outright.
 *
 * `LoroSyncPlugin` maps CodeMirror positions onto whatever the accessor hands
 * it at that moment, so an answer that changes identity leaves the view's
 * offsets addressing text that container never had. loro-crdt throws
 * `Index out of bound`, `@codemirror/view` catches it, logs
 * `CodeMirror plugin crashed` and DISABLES the plugin for good — the pane
 * keeps taking input and reaches nothing.
 *
 * `use-markdown-document`'s `bodyTextOf` is a live resolver of exactly this
 * shape: it reads `hostRef.current` on every call and answers with the
 * workspace tree-node container or the root one depending on what it finds.
 * This pins the consequence rather than the trigger, and doubles as the
 * detector's own mutation check — a run that finds nothing here is looking at
 * a guard that stopped guarding.
 */
it('reports a binding whose container changes under the mounted view', async () => {
  const crashes = expectCodeMirrorPluginCrash()
  const doc = new Loro()
  doc.getText('body').insert(0, 'hello ')
  doc.commit()
  let key = 'body'
  const binding = [LoroSyncPlugin(doc as LoroDoc, (d) => d.getText(key))]
  const { container } = render(
    <div style={{ width: 800, height: 300 }}>
      <MarkdownEditor
        initialViewMode="write"
        value="hello "
        onChange={() => {}}
        previewDebounceMs={0}
        sourceExtensions={binding}
      />
    </div>,
  )
  await focusEditable(() => container.querySelector('.cm-content'))
  key = 'somewhere-else'
  await userEvent.keyboard('{End}world')

  await vi.waitFor(() => {
    expect(crashes.length).toBeGreaterThan(0)
  })
  expect(crashes.join('\n')).toContain('Index out of bound')
})
