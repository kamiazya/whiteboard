/**
 * Editor/preview split UX: a draggable divider resizes the panes, and
 * scrolling the source proportionally scrolls the preview. Real browser —
 * both behaviors depend on real layout/scroll metrics jsdom cannot fake.
 */
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { MarkdownEditor } from './MarkdownEditor.js'

afterEach(cleanup)

const LONG_DOC = Array.from({ length: 80 }, (_, i) => `paragraph ${i}`).join('\n\n')

function mount(value = '') {
  const utils = render(
    <div style={{ width: 800, height: 300 }}>
      <MarkdownEditor value={value} onChange={() => {}} previewDebounceMs={0} />
    </div>,
  )
  return utils
}

describe('MarkdownEditor split & scroll sync (real browser)', () => {
  it('dragging the divider resizes the source pane', async () => {
    const { getByTestId } = mount()
    const divider = getByTestId('markdown-split-divider')
    const source = getByTestId('markdown-source-pane')
    const before = source.getBoundingClientRect().width

    const r = divider.getBoundingClientRect()
    divider.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        clientX: r.left + 2,
        clientY: r.top + 50,
        pointerId: 3,
        button: 0,
      }),
    )
    divider.dispatchEvent(
      new PointerEvent('pointermove', {
        bubbles: true,
        clientX: r.left - 150,
        clientY: r.top + 50,
        pointerId: 3,
      }),
    )
    divider.dispatchEvent(
      new PointerEvent('pointerup', {
        bubbles: true,
        clientX: r.left - 150,
        clientY: r.top + 50,
        pointerId: 3,
      }),
    )

    await vi.waitFor(() => {
      const after = source.getBoundingClientRect().width
      expect(after).toBeLessThan(before - 100)
    })
  })

  it('the divider is keyboard-operable (arrow keys move the split)', async () => {
    const { getByTestId } = mount()
    const divider = getByTestId('markdown-split-divider')
    const source = getByTestId('markdown-source-pane')
    const before = source.getBoundingClientRect().width

    divider.focus()
    await userEvent.keyboard('{ArrowLeft}{ArrowLeft}')
    await vi.waitFor(() => {
      expect(source.getBoundingClientRect().width).toBeLessThan(before)
    })
  })

  it('scrolling the source proportionally scrolls the preview', async () => {
    mount(LONG_DOC)
    const scroller = await vi.waitFor(() => {
      const el = document.querySelector('.cm-scroller') as HTMLElement
      expect(el.scrollHeight).toBeGreaterThan(el.clientHeight)
      return el
    })
    const preview = await vi.waitFor(() => {
      const el = document.querySelector('[data-testid="markdown-preview-scroll"]') as HTMLElement
      expect(el.scrollHeight).toBeGreaterThan(el.clientHeight)
      return el
    })

    scroller.scrollTop = scroller.scrollHeight
    scroller.dispatchEvent(new Event('scroll'))

    await vi.waitFor(() => {
      expect(preview.scrollTop).toBeGreaterThan(0)
    })
  })
})
