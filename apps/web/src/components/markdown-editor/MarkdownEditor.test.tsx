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

  it('disables the formatting buttons in Read mode and re-enables them in Write', () => {
    const { getByRole } = render(<MarkdownEditor value="# Hi" onChange={() => {}} />)
    const bold = getByRole('button', { name: 'Bold' }) as HTMLButtonElement
    expect(bold.disabled).toBe(false)

    fireEvent.click(getByRole('button', { name: 'Read' }))
    expect(bold.disabled).toBe(true)

    fireEvent.click(getByRole('button', { name: 'Write' }))
    expect(bold.disabled).toBe(false)
  })

  it('falls back from Split to Write in a narrow container, reflecting it in the toolbar without overwriting the stored preference', () => {
    // jsdom has no ResizeObserver; stub one that reports a narrow container.
    class NarrowResizeObserver {
      private readonly callback: ResizeObserverCallback
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback
      }
      observe() {
        this.callback(
          [{ contentRect: { width: 480 } } as ResizeObserverEntry],
          this as unknown as ResizeObserver,
        )
      }
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', NarrowResizeObserver)
    try {
      window.localStorage.setItem('whiteboard.markdown-view-mode', 'split')
      const { getByRole, queryByTestId, queryByRole, getByTestId } = render(
        <MarkdownEditor value="# Hi" onChange={() => {}} />,
      )
      // Write layout is in effect: source only, no divider, no preview.
      expect(getByTestId('markdown-source-wrap').style.display).not.toBe('none')
      expect(queryByTestId('markdown-split-divider')).toBeNull()
      expect(queryByTestId('markdown-preview-pane')).toBeNull()
      // The toolbar reflects the EFFECTIVE mode (Split is not offered at all).
      expect(queryByRole('button', { name: 'Split' })).toBeNull()
      expect(getByRole('button', { name: 'Write' }).getAttribute('aria-pressed')).toBe('true')
      // The stored preference survives the fallback.
      expect(window.localStorage.getItem('whiteboard.markdown-view-mode')).toBe('split')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('opens a wikiLink target through onOpenCanvas instead of navigating the window', async () => {
    vi.useFakeTimers()
    const NOTE_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
    const onOpenCanvas = vi.fn()
    const { getByTestId } = render(
      <MarkdownEditor
        value={`See [[canvas:${NOTE_ID}|the plan]] and [external](https://example.com).`}
        onChange={() => {}}
        onOpenCanvas={onOpenCanvas}
        previewDebounceMs={150}
      />,
    )
    await act(async () => {
      vi.advanceTimersByTime(150)
    })
    const preview = getByTestId('markdown-preview-scroll')
    const wikiAnchor = preview.querySelector(`a[href="${NOTE_ID}"]`)
    expect(wikiAnchor).not.toBeNull()
    if (!wikiAnchor) throw new Error('unreachable')
    const intercepted = !fireEvent.click(wikiAnchor)
    expect(onOpenCanvas).toHaveBeenCalledWith(NOTE_ID)
    // preventDefault fired — the SPA never navigates to a bare-ULID URL.
    expect(intercepted).toBe(true)

    // External links keep default browser behavior and never call the seam.
    const external = preview.querySelector('a[href="https://example.com"]')
    expect(external).not.toBeNull()
    if (!external) throw new Error('unreachable')
    fireEvent.click(external)
    expect(onOpenCanvas).toHaveBeenCalledTimes(1)
  })

  it('intercepts browser-local UUID canvas ids too, not only daemon ULIDs', async () => {
    vi.useFakeTimers()
    // Browser-local canvases mint crypto.randomUUID() ids; the daemon mints
    // ULIDs. Both travel through the alias resolver into anchor hrefs.
    const UUID = '68f94ee9-80fe-4e7e-b1fc-dcf853e26da3'
    const onOpenCanvas = vi.fn()
    const { getByTestId } = render(
      <MarkdownEditor
        value="See [[Snippet]]."
        onChange={() => {}}
        resolveAlias={(alias) => (alias === 'Snippet' ? UUID : null)}
        onOpenCanvas={onOpenCanvas}
        previewDebounceMs={150}
      />,
    )
    await act(async () => {
      vi.advanceTimersByTime(150)
    })
    const anchor = getByTestId('markdown-preview-scroll').querySelector(`a[href="${UUID}"]`)
    expect(anchor).not.toBeNull()
    if (!anchor) throw new Error('unreachable')
    const intercepted = !fireEvent.click(anchor)
    expect(onOpenCanvas).toHaveBeenCalledWith(UUID)
    expect(intercepted).toBe(true)
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
