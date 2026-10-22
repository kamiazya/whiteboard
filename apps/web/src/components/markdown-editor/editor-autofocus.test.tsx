import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { MarkdownEditor } from './MarkdownEditor.js'

afterEach(cleanup)

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
