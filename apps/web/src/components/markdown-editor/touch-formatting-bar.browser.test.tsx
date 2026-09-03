// The keyboard-docked formatting bar: shown on a coarse pointer while a
// markdown editor holds the caret, docked to the window's bottom and lifted
// onto the keyboard's edge by however much of the window the keyboard covers.
// Chromium cannot raise a keyboard, so a fake visualViewport stands in (the
// same stand-in keyboard-avoidance uses). A lift of zero is also the shape
// `interactive-widget=resizes-content` produces on Chrome and Firefox, where
// the layout viewport shrinks instead and the keyboard occludes nothing.
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { MarkdownNodeEditor } from '../spatial-editor/MarkdownNodeEditor.js'
import { nodeEditorContent } from '../spatial-editor/node-editor-test-utils.js'
import { MarkdownEditor } from './MarkdownEditor.js'
import { TouchFormattingBar } from './TouchFormattingBar.js'
// The bar loads its panel lazily; importing it here moves that chunk's load
// into the collection phase, off the per-assertion retry budget.
import './TouchFormattingBarPanel.js'
import { TOUCH_BAR_HEIGHT_PX } from './verb-bar-layout.js'

const realMatchMedia = window.matchMedia
let coarse = true

class FakeVisualViewport extends EventTarget {
  height = window.innerHeight
  offsetTop = 0
}
let fake: FakeVisualViewport

beforeEach(async () => {
  // A phone's width, so the overflow split is the one a phone gets.
  await page.viewport(390, 844)
  coarse = true
  window.matchMedia = (query: string) =>
    query === '(pointer: coarse)'
      ? ({ matches: coarse, media: query } as MediaQueryList)
      : realMatchMedia.call(window, query)
  fake = new FakeVisualViewport()
  Object.defineProperty(window, 'visualViewport', { value: fake, configurable: true })
})

afterEach(() => {
  cleanup()
  window.matchMedia = realMatchMedia
  delete (window as { visualViewport?: unknown }).visualViewport
})

/** Shrinks the fake viewport by `keyboardPx`, as a keyboard sliding in does. */
function raiseKeyboard(keyboardPx: number): void {
  fake.height = window.innerHeight - keyboardPx
  fake.dispatchEvent(new Event('resize'))
}

const BOX = { x: 20, y: 20, width: 240, height: 80 }
const bar = () =>
  document.querySelector('[data-testid="touch-formatting-bar"]') as HTMLElement | null
const settle = () => new Promise((resolve) => setTimeout(resolve, 60))

it('follows the visual viewport panning even when no scroll event fires', async () => {
  render(
    <>
      <MarkdownNodeEditor box={BOX} initialText="hello" onCommit={vi.fn()} onCancel={vi.fn()} />
      <TouchFormattingBar />
    </>,
  )
  await vi.waitFor(() => expect(document.activeElement?.closest('.cm-editor')).not.toBeNull())
  raiseKeyboard(300)
  await vi.waitFor(() => expect(bar()).not.toBeNull())

  // iOS pans the visual viewport during a fling and delivers the scroll
  // event once the fling settles, not per frame — so a bar that waits to be
  // TOLD where the edge is stays where the pan began, which is under the
  // keyboard. Panning with no event at all is that case at its limit.
  // (Where it ends up matters even though it is hidden mid-pan: it is what
  // the strip fades back in onto.)
  fake.offsetTop = 120
  await vi.waitFor(() =>
    expect((bar() as HTMLElement).getBoundingClientRect().bottom).toBeCloseTo(
      window.innerHeight - 300 + 120,
      0,
    ),
  )
})

it('docks to the window bottom on focus, then lifts onto the keyboard and back', async () => {
  render(
    <>
      <MarkdownNodeEditor box={BOX} initialText="hello" onCommit={vi.fn()} onCancel={vi.fn()} />
      <TouchFormattingBar />
    </>,
  )
  await vi.waitFor(() => expect(document.activeElement?.closest('.cm-editor')).not.toBeNull())

  // No lift yet — which is also, permanently, the resizes-content case.
  await vi.waitFor(() => expect(bar()).not.toBeNull())
  const docked = (bar() as HTMLElement).getBoundingClientRect()
  expect(docked.bottom).toBeCloseTo(window.innerHeight, 0)
  expect(docked.height).toBe(TOUCH_BAR_HEIGHT_PX)

  raiseKeyboard(300)
  await vi.waitFor(() =>
    expect((bar() as HTMLElement).getBoundingClientRect().bottom).toBeCloseTo(
      window.innerHeight - 300,
      0,
    ),
  )

  raiseKeyboard(0)
  await vi.waitFor(() =>
    expect((bar() as HTMLElement).getBoundingClientRect().bottom).toBeCloseTo(
      window.innerHeight,
      0,
    ),
  )
})

it('steps aside while the visual viewport is panning and returns once it stops', async () => {
  render(
    <>
      <MarkdownNodeEditor box={BOX} initialText="hello" onCommit={vi.fn()} onCancel={vi.fn()} />
      <TouchFormattingBar />
    </>,
  )
  await vi.waitFor(() => expect(document.activeElement?.closest('.cm-editor')).not.toBeNull())
  raiseKeyboard(300)
  await vi.waitFor(() => expect(bar()?.style.opacity).toBe('1'))

  // iOS pans the visual viewport on the compositor, so a main-thread read of
  // where it is is itself behind — reading per frame narrows the gap and
  // cannot close it. A strip trailing the keyboard's edge reads as broken;
  // one that stands down for the scroll reads as deliberate.
  for (let step = 1; step <= 4; step++) {
    fake.offsetTop = step * 20
    await new Promise((resolve) => requestAnimationFrame(resolve))
  }
  expect(bar()?.style.opacity).toBe('0')
  expect(bar()?.style.pointerEvents).toBe('none')

  await vi.waitFor(() => expect(bar()?.style.opacity).toBe('1'))
  expect(bar()?.style.pointerEvents).not.toBe('none')
})

it('tapping Bold wraps the caret word without committing the editor', async () => {
  const onCommit = vi.fn()
  const onChange = vi.fn()
  render(
    <>
      <MarkdownNodeEditor
        box={BOX}
        initialText="hello"
        onCommit={onCommit}
        onCancel={vi.fn()}
        onChange={onChange}
      />
      <TouchFormattingBar />
    </>,
  )
  await vi.waitFor(() => expect(document.activeElement?.closest('.cm-editor')).not.toBeNull())
  raiseKeyboard(300)
  await vi.waitFor(() => expect(bar()).not.toBeNull())

  await userEvent.click(screen.getByRole('button', { name: 'Bold' }))
  await settle()
  expect(onChange).toHaveBeenLastCalledWith('**hello**')
  expect(onCommit).not.toHaveBeenCalled()
  expect(document.activeElement?.closest('.cm-editor')).not.toBeNull()

  // A second tap toggles it back off — the phone's B behaves like every other B.
  await userEvent.click(screen.getByRole('button', { name: 'Bold' }))
  await settle()
  expect(onChange).toHaveBeenLastCalledWith('hello')
})

it('"…" opens the overflow sheet, and a verb from it acts on the document', async () => {
  const onChange = vi.fn()
  render(
    <>
      <MarkdownNodeEditor
        box={BOX}
        initialText=""
        onCommit={vi.fn()}
        onCancel={vi.fn()}
        onChange={onChange}
      />
      <TouchFormattingBar />
    </>,
  )
  await vi.waitFor(() => expect(document.activeElement?.closest('.cm-editor')).not.toBeNull())
  raiseKeyboard(300)
  await vi.waitFor(() => expect(bar()).not.toBeNull())
  expect(screen.queryByRole('menuitem', { name: 'Code block' })).toBeNull()

  await userEvent.click(screen.getByRole('button', { name: 'More formatting' }))
  const codeBlock = await screen.findByRole('menuitem', { name: 'Code block' })
  await userEvent.click(codeBlock)
  await settle()
  expect(onChange).toHaveBeenLastCalledWith('```\n\n```')
  expect(screen.queryByRole('menuitem', { name: 'Code block' })).toBeNull()
})

it('never shows on a fine pointer', async () => {
  coarse = false
  render(
    <>
      <MarkdownNodeEditor box={BOX} initialText="hello" onCommit={vi.fn()} onCancel={vi.fn()} />
      <TouchFormattingBar />
    </>,
  )
  await vi.waitFor(() => expect(document.activeElement?.closest('.cm-editor')).not.toBeNull())
  raiseKeyboard(300)
  await settle()
  expect(bar()).toBeNull()
})

it('follows the document editor too, and leaves when that editor unmounts', async () => {
  const { unmount } = render(
    <>
      <div style={{ height: 300 }}>
        <MarkdownEditor value="# Title" onChange={vi.fn()} autoFocus initialViewMode="write" />
      </div>
      <TouchFormattingBar />
    </>,
  )
  await vi.waitFor(() => expect(document.activeElement?.closest('.cm-editor')).not.toBeNull())
  raiseKeyboard(300)
  await vi.waitFor(() => expect(bar()).not.toBeNull())
  // The node editor is not mounted here, so the bar is the document editor's.
  expect(nodeEditorContent(document.body)).toBeNull()

  unmount()
  await vi.waitFor(() => expect(bar()).toBeNull())
})
