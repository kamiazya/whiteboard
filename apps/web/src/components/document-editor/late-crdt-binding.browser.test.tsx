/**
 * The window between a CRDT binding ARRIVING as a prop and the editor view
 * carrying it. `SourcePane` creates its CodeMirror view once per mount, and
 * this surface flips `onChange` to a no-op the moment the binding prop
 * appears — so if the view is not remounted at that moment, typing goes into
 * CodeMirror and nowhere else.
 */
import type { Extension } from '@codemirror/state'
import { cleanup, render } from '@testing-library/react'
import { Loro, type LoroDoc } from 'loro-crdt'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { loroTextSync } from '../../lib/loro-codemirror-sync.js'
import { focusEditable } from '../../test-utils/focus-editable.js'
import { DocumentEditorSurface } from './DocumentEditorSurface.js'

afterEach(cleanup)

function Host({ extensions }: { extensions?: readonly Extension[] }) {
  const [body, setBody] = useState('')
  return (
    <div style={{ width: 800, height: 300 }}>
      <DocumentEditorSurface
        kind="markdown"
        documentKey="doc-1"
        spatial={() => null}
        markdown={{
          body,
          setBody,
          ...(extensions === undefined ? {} : { sourceExtensions: extensions }),
        }}
      />
    </div>
  )
}

it('a binding that arrives after the editor mounted still takes the writes', async () => {
  const doc = new Loro()
  const binding: Extension[] = [loroTextSync(doc as LoroDoc, (d) => d.getText('body'))]

  const { container, rerender } = render(<Host />)
  await focusEditable(() => container.querySelector('.cm-content'))

  rerender(<Host extensions={binding} />)
  await focusEditable(() => container.querySelector('.cm-content'))
  await userEvent.keyboard('body first')

  await vi.waitFor(() => {
    expect(doc.getText('body').toString()).toBe('body first')
  })
})

it('a REPLACED document takes the writes, and the old one stops taking them', async () => {
  const first = new Loro()
  const second = new Loro()
  const bindingFor = (d: Loro): Extension[] => [
    loroTextSync(d as LoroDoc, (x) => x.getText('body')),
  ]

  const firstBinding = bindingFor(first)
  const { container, rerender } = render(<Host extensions={firstBinding} />)
  await focusEditable(() => container.querySelector('.cm-content'))
  await userEvent.keyboard('one')
  await vi.waitFor(() => expect(first.getText('body').toString()).toBe('one'))

  rerender(<Host extensions={bindingFor(second)} />)
  await focusEditable(() => container.querySelector('.cm-content'))
  await userEvent.keyboard('two')

  await vi.waitFor(() => expect(second.getText('body').toString()).toContain('two'))
  expect(first.getText('body').toString()).toBe('one')
})

it('the editor survives a re-render that does not change the binding', async () => {
  // The counterweight: keying on identity remounts the view, so an upstream
  // memo that rebuilt the array every render would throw the editor away
  // under whoever is typing. This fails if that ever happens.
  const doc = new Loro()
  const binding: Extension[] = [loroTextSync(doc as LoroDoc, (d) => d.getText('body'))]

  const { container, rerender } = render(<Host extensions={binding} />)
  await focusEditable(() => container.querySelector('.cm-content'))
  await userEvent.keyboard('kept')
  const view = container.querySelector('.cm-content')

  rerender(<Host extensions={binding} />)
  await new Promise((resolve) => setTimeout(resolve, 50))

  expect(container.querySelector('.cm-content')).toBe(view)
  expect(doc.getText('body').toString()).toBe('kept')
})
