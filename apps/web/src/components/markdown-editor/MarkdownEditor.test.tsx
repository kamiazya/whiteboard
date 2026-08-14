import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MarkdownEditor } from './MarkdownEditor.js'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  window.localStorage.clear()
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

  it('Read mode hides the source pane without unmounting it; Write mode drops the preview', () => {
    const { getByTestId, getByRole, queryByTestId } = render(
      <MarkdownEditor value="# Hi" onChange={() => {}} />,
    )
    // Default: split — both panes and the divider.
    expect(getByTestId('markdown-split-divider')).toBeTruthy()

    fireEvent.click(getByRole('button', { name: 'Read' }))
    // Still mounted (CodeMirror keeps its undo history), only hidden.
    const sourceWrap = getByTestId('markdown-source-wrap')
    expect(sourceWrap.style.display).toBe('none')
    expect(getByTestId('markdown-preview-pane')).toBeTruthy()
    expect(queryByTestId('markdown-split-divider')).toBeNull()

    fireEvent.click(getByRole('button', { name: 'Write' }))
    expect(sourceWrap.style.display).not.toBe('none')
    expect(queryByTestId('markdown-preview-pane')).toBeNull()
    expect(queryByTestId('markdown-split-divider')).toBeNull()
  })

  it('persists the chosen view mode and restores it on the next mount', () => {
    const first = render(<MarkdownEditor value="# Hi" onChange={() => {}} />)
    fireEvent.click(first.getByRole('button', { name: 'Read' }))
    first.unmount()

    const second = render(<MarkdownEditor value="# Hi" onChange={() => {}} />)
    expect(second.getByTestId('markdown-source-wrap').style.display).toBe('none')
    expect(second.getByRole('button', { name: 'Read' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('shows a word count that follows the debounced value', async () => {
    vi.useFakeTimers()
    const { getByTestId, rerender } = render(
      <MarkdownEditor value="# Hi there" onChange={() => {}} previewDebounceMs={150} />,
    )
    await act(async () => {
      vi.advanceTimersByTime(150)
    })
    // "#" is markup, not a word.
    expect(getByTestId('markdown-word-count').textContent).toContain('2')
    rerender(
      <MarkdownEditor value="# Hi there again" onChange={() => {}} previewDebounceMs={150} />,
    )
    await act(async () => {
      vi.advanceTimersByTime(150)
    })
    expect(getByTestId('markdown-word-count').textContent).toContain('3')
  })

  it('renders the core facets as a document header in Read mode', () => {
    const { getByRole, getByTestId } = render(
      <MarkdownEditor
        value="body"
        onChange={() => {}}
        meta={{ type: 'issue', title: 'Release plan', tags: ['q3', 'infra'] }}
      />,
    )
    fireEvent.click(getByRole('button', { name: 'Read' }))
    const header = getByTestId('markdown-document-header')
    expect(header.textContent).toContain('Release plan')
    expect(header.textContent).toContain('issue')
    expect(header.textContent).toContain('q3')
    expect(header.textContent).toContain('infra')
  })
})
