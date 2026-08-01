import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MarkdownEditor } from './MarkdownEditor.js'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('MarkdownEditor', () => {
  it('renders both a source pane and a preview pane for the given value', () => {
    const { getByTestId, container } = render(<MarkdownEditor value="# Hi" onChange={() => {}} />)
    expect(getByTestId('markdown-source-pane')).toBeTruthy()
    expect(getByTestId('markdown-preview-pane')).toBeTruthy()
    expect(container.textContent).toContain('Hi')
  })

  it('renders an empty document without throwing', () => {
    expect(() => render(<MarkdownEditor value="" onChange={() => {}} />)).not.toThrow()
  })

  it('preview reflects the current value once the debounce settles, without mutating the value prop', async () => {
    vi.useFakeTimers()
    const original = '# Original'
    const { getByTestId, rerender } = render(
      <MarkdownEditor value={original} onChange={() => {}} previewDebounceMs={150} />,
    )
    rerender(<MarkdownEditor value="# Changed" onChange={() => {}} previewDebounceMs={150} />)
    await act(async () => {
      vi.advanceTimersByTime(150)
    })
    expect(getByTestId('markdown-preview-pane').textContent).toContain('Changed')
    expect(original).toBe('# Original')
  })
})
