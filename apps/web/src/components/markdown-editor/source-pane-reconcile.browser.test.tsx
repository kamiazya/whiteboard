/**
 * External `value` reconciliation (real browser, real CodeMirror).
 *
 * The pane is controlled, so a change that did not originate from typing —
 * a load finishing, a remote CRDT update, a programmatic edit — arrives as
 * a new `value` prop.
 *
 * Applying it by replacing the whole document does NOT lose the caret
 * outright: CodeMirror maps the selection through every change, so a caret
 * at either end of the document still lands somewhere sensible. What a
 * whole-document replace destroys is everything strictly INSIDE the
 * replaced range — a caret mid-document collapses to the range boundary,
 * and an active selection collapses entirely. Under collaborative editing
 * that is every remote keystroke yanking the local caret out of the word
 * being typed.
 *
 * Asserted through where the NEXT typed character lands, so the test binds
 * to caret behavior rather than to CodeMirror's internal selection API.
 */
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { focusEditable } from '../../test-utils/focus-editable.js'
import { MarkdownEditor } from './MarkdownEditor.js'

afterEach(cleanup)

function editableOf(): HTMLElement {
  return document.querySelector('.cm-content') as HTMLElement
}

function lastValue(onChange: ReturnType<typeof vi.fn>): string {
  return (onChange.mock.calls.at(-1)?.[0] as string) ?? ''
}

describe('SourcePane external value reconciliation (real browser)', () => {
  it('keeps a mid-document caret when an external change lands after it', async () => {
    const onChange = vi.fn()
    const { rerender } = render(
      <MarkdownEditor initialViewMode="write" value="abcdef" onChange={onChange} />,
    )

    await focusEditable(editableOf)
    await userEvent.keyboard('{Home}{ArrowRight}{ArrowRight}{ArrowRight}')

    // Appended beyond the caret — nothing the caret sits on has moved, so it
    // must still be between "abc" and "def".
    rerender(<MarkdownEditor initialViewMode="write" value="abcdefgh" onChange={onChange} />)
    await expect.poll(() => editableOf().textContent).toBe('abcdefgh')

    await userEvent.keyboard('X')
    expect(lastValue(onChange)).toBe('abcXdefgh')
  })

  it('shifts the caret by an external insertion that lands before it', async () => {
    const onChange = vi.fn()
    const { rerender } = render(
      <MarkdownEditor initialViewMode="write" value="abc" onChange={onChange} />,
    )

    await focusEditable(editableOf)
    await userEvent.keyboard('{End}')

    // Prepended: the caret must follow the text it was anchored after, so it
    // ends up at the end of "ZZabc" rather than staying on offset 3.
    rerender(<MarkdownEditor initialViewMode="write" value="ZZabc" onChange={onChange} />)
    await expect.poll(() => editableOf().textContent).toBe('ZZabc')

    await userEvent.keyboard('X')
    expect(lastValue(onChange)).toBe('ZZabcX')
  })

  it('preserves an active selection across an external change elsewhere', async () => {
    const onChange = vi.fn()
    const { rerender } = render(
      <MarkdownEditor initialViewMode="write" value={'keep me\ntail'} onChange={onChange} />,
    )

    // Ctrl+Home rather than a click on the first line: the click had to reach
    // that line by hit-testing (the content column's vertical padding could
    // map its center to another line), and an absolute move states the intent
    // without depending on layout at all.
    await focusEditable(editableOf)
    await userEvent.keyboard('{Control>}{Home}{/Control}')
    // Select "keep" on the first line.
    await userEvent.keyboard('{Shift>}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{/Shift}')

    rerender(
      <MarkdownEditor initialViewMode="write" value={'keep me\ntail edited'} onChange={onChange} />,
    )
    await expect.poll(() => editableOf().textContent).toContain('tail edited')

    // Typing replaces the still-live selection instead of appending at the end.
    await userEvent.keyboard('Q')
    expect(lastValue(onChange)).toBe('Q me\ntail edited')
  })
})
