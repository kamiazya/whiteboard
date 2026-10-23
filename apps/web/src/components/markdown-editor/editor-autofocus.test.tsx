import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { noteFocusPlaced } from '../../lib/focus-claim.js'
import { MarkdownEditor } from './MarkdownEditor.js'

afterEach(() => {
  cleanup()
  noteFocusPlaced(Number.NEGATIVE_INFINITY)
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

it('names the editor "Markdown document" rather than by the text it holds', () => {
  mount('some prose the reader wrote')
  const box = document.querySelector('.cm-content') as HTMLElement
  expect(box.getAttribute('role')).toBe('textbox')
  expect(box.getAttribute('aria-label')).toBe('Markdown document')
})
