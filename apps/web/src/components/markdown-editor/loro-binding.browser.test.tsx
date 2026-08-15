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
  const cm = container.querySelector('.cm-content') as HTMLElement
  await userEvent.click(cm)
  await userEvent.keyboard('{End}world')
  await vi.waitFor(() => {
    expect(doc.getText('body').toString()).toBe('hello world')
  })
})

it('a remote edit merges into the editor and shifts the caret exactly', async () => {
  const { doc, container } = mountBound('alpha omega')
  const cm = container.querySelector('.cm-content') as HTMLElement
  await userEvent.click(cm)
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
