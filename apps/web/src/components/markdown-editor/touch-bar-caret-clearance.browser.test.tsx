// A caret typed past the visible area scrolls into view ABOVE the docked
// formatting bar, not under it. CodeMirror scrolls the caret to the edge of
// its scroller, and the bar is a fixed strip over that edge, so without a
// scroll margin the line being typed sits behind the bar.
import { EditorView } from '@codemirror/view'
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { setViewport } from '../../test-utils/viewport.js'
import { MarkdownEditor } from './MarkdownEditor.js'
import { TouchFormattingBar } from './TouchFormattingBar.js'
import './TouchFormattingBarPanel.js'

const realMatchMedia = window.matchMedia
let coarse = true

beforeEach(async () => {
  await setViewport(390, 500)
  coarse = true
  window.matchMedia = (query: string) =>
    query === '(pointer: coarse)'
      ? ({ matches: coarse, media: query } as MediaQueryList)
      : realMatchMedia.call(window, query)
})

afterEach(() => {
  cleanup()
  window.matchMedia = realMatchMedia
})

const bar = () =>
  document.querySelector('[data-testid="touch-formatting-bar"]') as HTMLElement | null

function viewOf(container: HTMLElement): EditorView {
  const dom = container.querySelector<HTMLElement>('.cm-editor')
  const view = dom === null ? null : EditorView.findFromDOM(dom)
  if (view === null) throw new Error('no editor view')
  return view
}

async function typeLines(count: number): Promise<void> {
  await userEvent.keyboard(Array.from({ length: count }, (_, i) => `line ${i}`).join('{Enter}'))
}

it('keeps the caret line above the docked bar once the note outgrows the screen', async () => {
  const { container } = render(
    <div style={{ height: '100vh', width: '100%' }}>
      <MarkdownEditor value="" onChange={vi.fn()} theme="light" onComposeThread={vi.fn()} />
      <TouchFormattingBar />
    </div>,
  )
  const view = viewOf(container)
  view.focus()
  await vi.waitFor(() => expect(bar()).not.toBeNull())
  await typeLines(30)
  await vi.waitFor(() => {
    const caret = view.coordsAtPos(view.state.selection.main.head)
    expect(caret).not.toBeNull()
    expect((caret as { bottom: number }).bottom).toBeLessThanOrEqual(
      (bar() as HTMLElement).getBoundingClientRect().top,
    )
  })
})

it('reserves nothing where no bar is shown', async () => {
  coarse = false
  const { container } = render(
    <div style={{ height: '100vh', width: '100%' }}>
      <MarkdownEditor value="" onChange={vi.fn()} theme="light" onComposeThread={vi.fn()} />
      <TouchFormattingBar />
    </div>,
  )
  const view = viewOf(container)
  view.focus()
  await typeLines(30)
  await vi.waitFor(() => {
    const caret = view.coordsAtPos(view.state.selection.main.head)
    expect(caret).not.toBeNull()
    // Scrolled to the scroller's own bottom edge, minus CodeMirror's default margin.
    const scrollerBottom = view.scrollDOM.getBoundingClientRect().bottom
    expect((caret as { bottom: number }).bottom).toBeGreaterThan(scrollerBottom - 44)
  })
})
