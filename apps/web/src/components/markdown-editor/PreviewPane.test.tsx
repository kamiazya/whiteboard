import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeMeasure } from '../../test-utils/fake-measure.js'
import { PreviewPane } from './PreviewPane.js'

// The real renderer, observed: which tag library each render was handed.
const rendered = vi.hoisted(() => ({ tagLibraries: [] as unknown[] }))
vi.mock('../../lib/render-preview.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/render-preview.js')>()
  return {
    ...real,
    renderMarkdownPreview: (...args: Parameters<typeof real.renderMarkdownPreview>) => {
      rendered.tagLibraries.push(args[1].tagLibrary)
      return real.renderMarkdownPreview(...args)
    },
  }
})

afterEach(() => {
  cleanup()
})

describe('PreviewPane', () => {
  it('renders an SVG whose content is produced by canvas-render, not an HTML markdown renderer', () => {
    const { container } = render(
      <PreviewPane theme="light" value="# Hello" maxWidth={480} measure={fakeMeasure} />,
    )
    const svg = container.querySelector('svg')
    expect(svg).not.toBeNull()
    expect(svg?.getAttribute('xmlns')).toBe('http://www.w3.org/2000/svg')
    expect(container.textContent).toContain('Hello')
  })

  it('renders an empty document without throwing', () => {
    expect(() =>
      render(<PreviewPane theme="light" value="" maxWidth={480} measure={fakeMeasure} />),
    ).not.toThrow()
  })

  // The render is memoised and the dependency lint is off, so a library left
  // out of the deps would keep an embedded board's old tag colours.
  it('renders again when only the tag library changes', () => {
    const before = { health: { values: { ok: { color: '4' } } } } as never
    const after = { health: { values: { ok: { color: '1' } } } } as never
    const { rerender } = render(
      <PreviewPane
        theme="light"
        value="# Hi"
        maxWidth={480}
        measure={fakeMeasure}
        tagLibrary={before}
      />,
    )
    rerender(
      <PreviewPane
        theme="light"
        value="# Hi"
        maxWidth={480}
        measure={fakeMeasure}
        tagLibrary={after}
      />,
    )
    expect(rendered.tagLibraries.at(-1)).toBe(after)
  })

  describe('task checkboxes', () => {
    const source = '# Plan\n\n- [ ] first\n  - [x] nested\n- plain\n- [ ] last\n'
    const boxes = (container: HTMLElement) =>
      Array.from(container.querySelectorAll('[role="checkbox"]'))

    it('reports the source line of the box that was clicked', () => {
      const onToggleTask = vi.fn()
      const { container } = render(
        <PreviewPane
          theme="light"
          value={source}
          maxWidth={480}
          measure={fakeMeasure}
          onToggleTask={onToggleTask}
        />,
      )
      expect(boxes(container).map((box) => box.getAttribute('aria-checked'))).toEqual([
        'false',
        'true',
        'false',
      ])
      fireEvent.click(boxes(container)[1] as Element)
      fireEvent.click(boxes(container)[2] as Element)
      expect(onToggleTask.mock.calls).toEqual([[4], [6]])
    })

    it('toggles from the keyboard on Enter and Space, and makes each box focusable', () => {
      const onToggleTask = vi.fn()
      const { container } = render(
        <PreviewPane
          theme="light"
          value={source}
          maxWidth={480}
          measure={fakeMeasure}
          onToggleTask={onToggleTask}
        />,
      )
      const first = boxes(container)[0] as Element
      expect(first.getAttribute('tabindex')).toBe('0')
      fireEvent.keyDown(first, { key: 'Enter' })
      fireEvent.keyDown(first, { key: ' ' })
      fireEvent.keyDown(first, { key: 'a' })
      expect(onToggleTask.mock.calls).toEqual([[3], [3]])
    })

    it('does nothing when the boxes drawn do not match the task lines in the source', () => {
      const onToggleTask = vi.fn()
      // A box the source has no task line for (an embedded note's, say) must not
      // be answered with a guess at someone else's line.
      const { container } = render(
        <PreviewPane
          theme="light"
          value={'- [ ] real\n'}
          maxWidth={480}
          measure={fakeMeasure}
          onToggleTask={onToggleTask}
        />,
      )
      const box = boxes(container)[0] as Element
      box.parentElement?.appendChild(box.cloneNode(true))
      fireEvent.click(box)
      expect(onToggleTask).not.toHaveBeenCalled()
    })

    it('draws no handle when the pane is read-only', () => {
      const { container } = render(
        <PreviewPane theme="light" value={source} maxWidth={480} measure={fakeMeasure} />,
      )
      expect(boxes(container)[0]?.getAttribute('tabindex')).toBeNull()
    })
  })
})
