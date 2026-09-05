// The vessel both keeper pages put the comments panel in: a column where
// there is width, a sheet over the editor on a phone — where a 288px column
// beside a 412px screen left the editor a strip a finger could not write in.
import type { CommentThread } from '@kamiazya/whiteboard-model'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import type { CommentsRail } from '../../hooks/use-comments-rail.js'
import { CommentsRailAside } from './CommentsRailChrome.js'

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

function railOpen(toggle = vi.fn()): CommentsRail {
  return {
    open: true,
    toggle,
    selectedThreadId: null,
    selectThread: vi.fn(),
    composeAnchor: null,
    revealThread: vi.fn(),
    composeThread: vi.fn(),
    cancelCompose: vi.fn(),
    openThreadCount: 1,
    resolveAnchor: undefined,
    createThread: vi.fn(),
    reply: vi.fn(),
    resolve: vi.fn(),
    editMessage: vi.fn(),
  }
}

function mount(toggle = vi.fn()) {
  render(
    <div style={{ position: 'relative', display: 'flex', height: 500 }}>
      <div style={{ flex: 1 }} data-testid="editor-stand-in" />
      <CommentsRailAside rail={railOpen(toggle)} threads={[THREAD]} writable />
    </div>,
  )
  return toggle
}

it('is a column beside the editor where there is width for one', async () => {
  mount()
  const rail = page.getByTestId('comments-rail').element()
  expect(getComputedStyle(rail).position).toBe('static')
  expect(rail.getBoundingClientRect().width).toBe(288)
})

it('is a sheet over the editor on a phone, and can be closed from it', async () => {
  await page.viewport(412, 700)
  const toggle = mount()
  const rail = page.getByTestId('comments-rail').element()
  const editor = page.getByTestId('editor-stand-in').element()
  expect(getComputedStyle(rail).position).toBe('absolute')
  // Over the editor, not beside it: the editor keeps the whole width.
  expect(editor.getBoundingClientRect().width).toBe(412)
  // The grab handle SHOWS its state: the one chevron turns with aria-expanded
  // rather than being swapped, so what is announced and what is drawn are
  // one value.
  const handle = page.getByTestId('comments-stage-toggle').element()
  const chevron = handle.querySelector('svg') as SVGElement
  expect(getComputedStyle(chevron).rotate).toBe('none')
  await userEvent.click(page.getByRole('button', { name: 'Expand comments' }))
  expect(handle.getAttribute('aria-expanded')).toBe('true')
  // Polled: the turn is a transition, so right after the click the computed
  // rotation is a few degrees along the way rather than the destination.
  await expect.poll(() => getComputedStyle(chevron).rotate).toBe('180deg')
  await userEvent.click(page.getByRole('button', { name: 'Close comments' }))
  expect(toggle).toHaveBeenCalledTimes(1)
})
