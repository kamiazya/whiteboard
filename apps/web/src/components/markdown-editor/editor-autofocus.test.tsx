import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { noteFocusPlaced, resetFocusClaim } from '../../lib/focus-claim.js'
import { MarkdownEditor } from './MarkdownEditor.js'

afterEach(() => {
  cleanup()
  resetFocusClaim()
})

const mount = (value: string) =>
  render(
    <MarkdownEditor
      value={value}
      onChange={vi.fn()}
      theme="light"
      autoFocus
      onComposeThread={vi.fn()}
    />,
  )

it('focuses a new empty note, which the reader opened to write in', () => {
  const { container } = mount('')
  expect(document.activeElement).toBe(container.querySelector('.cm-content'))
})

it('leaves an existing note unfocused, so Tab can still reach the page around it', () => {
  mount('already written')
  expect(document.activeElement?.closest('.cm-editor')).toBeNull()
})

it('does not take focus from a field the reader already typed in, even after it lost focus', () => {
  noteFocusPlaced()
  const { container } = mount('')
  expect(document.activeElement?.closest('.cm-editor') ?? null).toBeNull()
  expect(container.querySelector('.cm-content')).not.toBeNull()
})
