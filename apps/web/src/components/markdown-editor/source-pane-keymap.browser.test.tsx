/**
 * SourcePane editing keymap (real CodeMirror input path): before this
 * slice the pane had NO keymap and NO history extension — Cmd+Z did
 * nothing, Tab moved focus out of the editor, and there was no styling
 * shortcut. These are table-stakes for a markdown editor.
 */
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { focusEditable } from '../../test-utils/focus-editable.js'
import { MarkdownEditor } from './MarkdownEditor.js'

// CodeMirror's Mod- prefix resolves to Cmd on macOS and Ctrl elsewhere;
// CI runs Linux, local dev runs macOS, so the tests must send whichever
// modifier the platform under test actually binds.
const MOD = navigator.platform.toUpperCase().includes('MAC') ? 'Meta' : 'Control'
const mod = (key: string) => `{${MOD}>}${key}{/${MOD}}`

afterEach(cleanup)

function mountEditor() {
  const onChange = vi.fn()
  const utils = render(<MarkdownEditor initialViewMode="write" value="" onChange={onChange} />)
  const editable = () =>
    utils.getByTestId('markdown-source-pane').querySelector('[contenteditable="true"]')
  return { onChange, editable }
}

function lastValue(onChange: ReturnType<typeof vi.fn>): string {
  return (onChange.mock.calls.at(-1)?.[0] as string) ?? ''
}

describe('SourcePane keymap (real browser)', () => {
  it('Mod-z undoes typing', async () => {
    const { onChange, editable } = mountEditor()
    await focusEditable(editable)
    await userEvent.keyboard('hello')
    await userEvent.keyboard(mod('z'))
    expect(lastValue(onChange)).not.toBe('hello')
  })

  it('Tab indents instead of leaving the editor', async () => {
    const { onChange, editable } = mountEditor()
    await focusEditable(editable)
    await userEvent.keyboard('item')
    await userEvent.keyboard('{Home}')
    await userEvent.keyboard('{Tab}')
    expect(lastValue(onChange)).toMatch(/^(\t| {2,})item$/)
    // Focus stayed inside CodeMirror.
    expect(document.activeElement?.closest('.cm-editor')).not.toBeNull()
  })

  it('Mod-b wraps the selection in strong emphasis', async () => {
    const { onChange, editable } = mountEditor()
    await focusEditable(editable)
    await userEvent.keyboard('bold')
    await userEvent.keyboard(mod('a'))
    await userEvent.keyboard(mod('b'))
    expect(lastValue(onChange)).toBe('**bold**')
  })

  it('Mod-i wraps the selection in emphasis', async () => {
    const { onChange, editable } = mountEditor()
    await focusEditable(editable)
    await userEvent.keyboard('slanted')
    await userEvent.keyboard(mod('a'))
    await userEvent.keyboard(mod('i'))
    expect(lastValue(onChange)).toBe('*slanted*')
  })

  it('Mod-b with a collapsed selection inserts delimiters and keeps the cursor between them', async () => {
    const { onChange, editable } = mountEditor()
    await focusEditable(editable)
    await userEvent.keyboard(mod('b'))
    await userEvent.keyboard('x')
    expect(lastValue(onChange)).toBe('**x**')
  })

  it('long lines soft-wrap instead of scrolling horizontally', async () => {
    // The behavior under test is wrap LAYOUT, not typing: mount with the
    // long line as the initial value instead of sending ~400 individual
    // keystrokes through the real event pipeline — per-key CodeMirror
    // update cycles made this test time out under full-suite load.
    render(
      <MarkdownEditor
        initialViewMode="write"
        value={'word '.repeat(80).trim()}
        onChange={vi.fn()}
      />,
    )
    // Wait for the long line to actually render first — asserting widths on a
    // not-yet-measured (effectively empty) editor would pass vacuously.
    const content = document.querySelector('.cm-content') as HTMLElement
    await expect.poll(() => content.textContent?.includes('word word')).toBe(true)
    const scroller = document.querySelector('.cm-scroller') as HTMLElement
    await expect.poll(() => scroller.scrollWidth <= scroller.clientWidth + 1).toBe(true)
  })
})

describe('SourcePane markdown ergonomics (real browser)', () => {
  it('Enter continues an unordered list marker', async () => {
    const { onChange, editable } = mountEditor()
    await focusEditable(editable)
    await userEvent.keyboard('- one{Enter}two')
    expect(lastValue(onChange)).toBe('- one\n- two')
  })

  it('Enter increments an ordered list marker', async () => {
    const { onChange, editable } = mountEditor()
    await focusEditable(editable)
    await userEvent.keyboard('1. one{Enter}two')
    expect(lastValue(onChange)).toBe('1. one\n2. two')
  })

  it('Enter on an empty list item removes the marker instead of continuing forever', async () => {
    const { onChange, editable } = mountEditor()
    await focusEditable(editable)
    // First Enter continues to "- "; the second, on the now-empty item,
    // deletes the marker and leaves the caret on the emptied line.
    await userEvent.keyboard('- one{Enter}{Enter}after')
    expect(lastValue(onChange)).toBe('- one\nafter')
  })

  it('Mod-Enter toggles a task checkbox on the caret line', async () => {
    const { onChange, editable } = mountEditor()
    await focusEditable(editable)
    // `[[` is userEvent.keyboard's escape for a literal `[`.
    await userEvent.keyboard('- [[ ] task')
    await userEvent.keyboard(mod('{Enter}'))
    expect(lastValue(onChange)).toBe('- [x] task')
    // The chord walks the checkbox cycle on: done -> no checkbox, marker kept.
    await userEvent.keyboard(mod('{Enter}'))
    expect(lastValue(onChange)).toBe('- task')
  })

  it('Mod-e wraps the selection in backticks', async () => {
    const { onChange, editable } = mountEditor()
    await focusEditable(editable)
    await userEvent.keyboard('code')
    await userEvent.keyboard(mod('a'))
    await userEvent.keyboard(mod('e'))
    expect(lastValue(onChange)).toBe('`code`')
  })
})
