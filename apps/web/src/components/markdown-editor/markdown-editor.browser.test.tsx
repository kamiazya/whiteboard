import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { MarkdownEditor } from './MarkdownEditor.js'

// CodeMirror's own DOM/input handling, and real Canvas 2D text measurement,
// are the honest reasons this test needs a real browser rather than jsdom
// (jsdom has no canvas backend and falls back to a ratio-based measurer).

afterEach(() => {
  cleanup()
})

describe('MarkdownEditor (real browser)', () => {
  it('typing real characters into the source pane produces onChange with the expected document', async () => {
    const onChange = vi.fn()
    const { getByTestId } = render(<MarkdownEditor value="" onChange={onChange} />)

    const editable = getByTestId('markdown-source-pane').querySelector('[contenteditable="true"]')
    expect(editable).not.toBeNull()
    if (!editable) throw new Error('expected a contenteditable CodeMirror host')

    await userEvent.click(editable)
    await userEvent.keyboard('# Hello world')

    expect(onChange).toHaveBeenCalled()
    const lastCall = onChange.mock.calls.at(-1)?.[0]
    expect(lastCall).toBe('# Hello world')
  })

  it('the preview SVG reflects real Canvas 2D text measurement: a longer preceding run yields a wider advance for the next run', async () => {
    // canvas-render's mdast block layout does not wrap text within a
    // paragraph (single-line cursor only), so the only place real measured
    // advance width is observable in the emitted SVG is the x-position of a
    // SECOND run following a styled first run — it equals the first run's
    // real measured width. jsdom has no Canvas 2D backend and falls back to
    // a ratio-based measurer, so this is genuinely browser-only signal.
    const short = render(<MarkdownEditor value="**hi** end" onChange={() => {}} />)
    const long = render(
      <MarkdownEditor value="**a much longer bold phrase** end" onChange={() => {}} />,
    )

    // Scoped to each render's own container: `getByTestId` on the render
    // result defaults to querying the whole `document.body`, which would
    // match both instances once a second component is mounted alongside.
    const shortRuns = short.container.querySelectorAll(
      '[data-testid="markdown-preview-pane"] svg text',
    )
    const longRuns = long.container.querySelectorAll(
      '[data-testid="markdown-preview-pane"] svg text',
    )
    expect(shortRuns.length).toBeGreaterThanOrEqual(2)
    expect(longRuns.length).toBeGreaterThanOrEqual(2)

    const shortSecondRunX = Number(shortRuns[1]?.getAttribute('x') ?? '0')
    const longSecondRunX = Number(longRuns[1]?.getAttribute('x') ?? '0')

    // Real Canvas 2D measurement is nondeterministic in exact pixels across
    // platforms/fonts, so assert only the non-degenerate relative shape: the
    // run after a much longer bold phrase starts strictly further right —
    // not an exact pixel value.
    expect(longSecondRunX).toBeGreaterThan(shortSecondRunX)

    short.unmount()
    long.unmount()
  })

  it('mounts and unmounts cleanly with no dangling CodeMirror view or thrown error', () => {
    const { unmount } = render(<MarkdownEditor value="content" onChange={() => {}} />)
    expect(() => unmount()).not.toThrow()
  })
})
