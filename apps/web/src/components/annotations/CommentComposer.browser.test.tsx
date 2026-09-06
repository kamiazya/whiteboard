/**
 * The box a comment is written in, as a markdown editor.
 *
 * A real browser: CodeMirror needs layout and real key events, and the two
 * claims here — a chord that sends, a chord that wraps a selection — are
 * both keyboard.
 */
import { cleanup, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { CommentComposer } from './CommentComposer.js'

afterEach(cleanup)

function Host({ onSubmit }: { readonly onSubmit: (value: string) => void }) {
  const [value, setValue] = useState('')
  return (
    <CommentComposer
      value={value}
      onChange={setValue}
      onSubmit={() => onSubmit(value)}
      label="Reply"
      placeholderText="Reply…"
    />
  )
}

const box = () => page.getByRole('textbox', { name: 'Reply' })

it('sends on Ctrl+Enter and on Meta+Enter, so the chord survives changing machines', async () => {
  // NOT CodeMirror's `Mod-`, which is Cmd on a Mac and Ctrl everywhere
  // else: the textarea this replaces took either modifier on every
  // platform, and binding `Mod` alone would have quietly dropped
  // Ctrl+Enter for a Mac reader.
  const sent: string[] = []
  render(<Host onSubmit={(value) => sent.push(value)} />)

  await userEvent.click(box())
  await userEvent.keyboard('first')
  await userEvent.keyboard('{Control>}{Enter}{/Control}')
  await userEvent.keyboard('{Meta>}{Enter}{/Meta}')

  expect(sent).toEqual(['first', 'first'])
})

it('keeps Enter as a newline, because a comment is prose', async () => {
  const sent: string[] = []
  render(<Host onSubmit={(value) => sent.push(value)} />)

  await userEvent.click(box())
  await userEvent.keyboard('one{Enter}two')

  expect(sent).toEqual([])
  await vi.waitFor(() => expect(document.querySelectorAll('.cm-line').length).toBeGreaterThan(1))
})

it('wraps a selection in bold on Mod+b, the editing verb the note pane has', async () => {
  // The point of reusing the note's own CodeMirror host rather than
  // standing up a second one: the closed verb set comes with it.
  render(<Host onSubmit={() => {}} />)

  await userEvent.click(box())
  await userEvent.keyboard('tighten')
  await userEvent.keyboard('{Control>}a{/Control}')
  await userEvent.keyboard('{Control>}b{/Control}')

  await vi.waitFor(() => expect(box().element().textContent).toBe('**tighten**'))
})
