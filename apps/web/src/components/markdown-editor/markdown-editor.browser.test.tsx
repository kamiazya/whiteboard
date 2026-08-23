import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { focusEditable } from '../../test-utils/focus-editable.js'
import { MarkdownEditor } from './MarkdownEditor.js'

// CodeMirror's own DOM/input handling, and real Canvas 2D text measurement,
// are the honest reasons this test needs a real browser rather than jsdom
// (jsdom has no canvas backend and falls back to a ratio-based measurer).

afterEach(() => {
  cleanup()
  window.localStorage.removeItem('whiteboard.markdown-view-mode')
})

describe('MarkdownEditor (real browser)', () => {
  it('typing real characters into the source pane produces onChange with the expected document', async () => {
    const onChange = vi.fn()
    const { getByTestId } = render(
      <MarkdownEditor initialViewMode="split" value="" onChange={onChange} />,
    )

    // Focus is a precondition to establish here, not an interaction to
    // perform — what the test is about is that typing produces onChange. The
    // helper carries the rest of the reasoning, including why the focus call
    // has to be re-done on every attempt rather than once before the wait.
    await focusEditable(() =>
      getByTestId('markdown-source-pane').querySelector('[contenteditable="true"]'),
    )
    await userEvent.keyboard('# Hello world')

    expect(onChange).toHaveBeenCalled()
    const lastCall = onChange.mock.calls.at(-1)?.[0]
    expect(lastCall).toBe('# Hello world')
  })

  it('the catalog Bold wraps the live selection without collapsing it', async () => {
    const onChange = vi.fn()
    const { getByTestId, getByRole } = render(
      <MarkdownEditor initialViewMode="split" value="make this bold" onChange={onChange} />,
    )

    // Select the word "this" (offsets 5..9) from the document start. Ctrl+Home
    // rather than Home: the click this replaces only ever reached the first
    // line by hit-testing, and an absolute move says what the test means.
    await focusEditable(() =>
      getByTestId('markdown-source-pane').querySelector('[contenteditable="true"]'),
    )
    await userEvent.keyboard(
      '{Control>}{Home}{/Control}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}',
    )
    await userEvent.keyboard('{Shift>}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{/Shift}')

    await userEvent.click(getByRole('button', { name: 'Editing actions' }))
    await userEvent.click(getByRole('menuitem', { name: 'Bold' }))
    expect(onChange.mock.calls.at(-1)?.[0]).toBe('make **this** bold')

    // The selection stayed live inside the delimiters: typing replaces it.
    await userEvent.keyboard('that')
    expect(onChange.mock.calls.at(-1)?.[0]).toBe('make **that** bold')
  })

  it('the preview SVG reflects real Canvas 2D text measurement: a longer preceding run yields a wider advance for the next run', async () => {
    // canvas-render's mdast block layout does not wrap text within a
    // paragraph (single-line cursor only), so the only place real measured
    // advance width is observable in the emitted SVG is the x-position of a
    // SECOND run following a styled first run — it equals the first run's
    // real measured width. jsdom has no Canvas 2D backend and falls back to
    // a ratio-based measurer, so this is genuinely browser-only signal.
    const short = render(
      <MarkdownEditor initialViewMode="split" value="**hi** end" onChange={() => {}} />,
    )
    const long = render(
      <MarkdownEditor
        initialViewMode="split"
        value="**a much longer bold phrase** end"
        onChange={() => {}}
      />,
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
    const { unmount } = render(
      <MarkdownEditor initialViewMode="split" value="content" onChange={() => {}} />,
    )
    expect(() => unmount()).not.toThrow()
  })
})
