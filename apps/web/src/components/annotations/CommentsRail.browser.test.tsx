// The vessel both keeper pages put the comments panel in: a column where
// there is width, a sheet over the editor on a phone — where a 288px column
// beside a 412px screen left the editor a strip a finger could not write in.
import type { CommentThread } from '@kamiazya/whiteboard-model'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { CommentsRail } from './CommentsRail.js'

afterEach(async () => {
  cleanup()
  await page.viewport(800, 600)
})

const THREAD: CommentThread = {
  id: 't1',
  anchor: { kind: 'text', quote: { exact: 'x' }, start: 0, end: 1 },
  status: 'open',
  messages: [{ id: 'm1', body: 'tighten the copy here' }],
}

function mount(onClose = vi.fn()) {
  render(
    <div style={{ position: 'relative', display: 'flex', height: 500 }}>
      <div style={{ flex: 1 }} data-testid="editor-stand-in" />
      <CommentsRail threads={[THREAD]} onClose={onClose} />
    </div>,
  )
  return onClose
}

it('is a column beside the editor where there is width for one', async () => {
  mount()
  const rail = page.getByTestId('comments-rail').element()
  expect(getComputedStyle(rail).position).toBe('static')
  expect(rail.getBoundingClientRect().width).toBe(288)
})

it('is a sheet over the editor on a phone, and can be closed from it', async () => {
  await page.viewport(412, 700)
  const onClose = mount()
  const rail = page.getByTestId('comments-rail').element()
  const editor = page.getByTestId('editor-stand-in').element()
  expect(getComputedStyle(rail).position).toBe('absolute')
  // Over the editor, not beside it: the editor keeps the whole width.
  expect(editor.getBoundingClientRect().width).toBe(412)
  await userEvent.click(page.getByRole('button', { name: 'Close comments' }))
  expect(onClose).toHaveBeenCalledTimes(1)
})
