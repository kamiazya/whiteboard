/**
 * SourcePane editing keymap (real CodeMirror input path): before this
 * slice the pane had NO keymap and NO history extension — Cmd+Z did
 * nothing, Tab moved focus out of the editor, and there was no styling
 * shortcut. These are table-stakes for a markdown editor.
 */
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { MarkdownEditor } from './MarkdownEditor.js'

// CodeMirror's Mod- prefix resolves to Cmd on macOS and Ctrl elsewhere;
// CI runs Linux, local dev runs macOS, so the tests must send whichever
// modifier the platform under test actually binds.
const MOD = navigator.platform.toUpperCase().includes('MAC') ? 'Meta' : 'Control'
const mod = (key: string) => `{${MOD}>}${key}{/${MOD}}`

afterEach(cleanup)

function mountEditor() {
  const onChange = vi.fn()
  const utils = render(<MarkdownEditor value="" onChange={onChange} />)
  const editable = utils
    .getByTestId('markdown-source-pane')
    .querySelector('[contenteditable="true"]') as HTMLElement
  return { onChange, editable }
}

function lastValue(onChange: ReturnType<typeof vi.fn>): string {
  return (onChange.mock.calls.at(-1)?.[0] as string) ?? ''
}

describe('SourcePane keymap (real browser)', () => {
  it('Mod-z undoes typing', async () => {
    const { onChange, editable } = mountEditor()
    await userEvent.click(editable)
    await userEvent.keyboard('hello')
    await userEvent.keyboard(mod('z'))
    expect(lastValue(onChange)).not.toBe('hello')
  })

  it('Tab indents instead of leaving the editor', async () => {
    const { onChange, editable } = mountEditor()
    await userEvent.click(editable)
    await userEvent.keyboard('item')
    await userEvent.keyboard('{Home}')
    await userEvent.keyboard('{Tab}')
    expect(lastValue(onChange)).toMatch(/^(\t| {2,})item$/)
    // Focus stayed inside CodeMirror.
    expect(document.activeElement?.closest('.cm-editor')).not.toBeNull()
  })

  it('Mod-b wraps the selection in strong emphasis', async () => {
    const { onChange, editable } = mountEditor()
    await userEvent.click(editable)
    await userEvent.keyboard('bold')
    await userEvent.keyboard(mod('a'))
    await userEvent.keyboard(mod('b'))
    expect(lastValue(onChange)).toBe('**bold**')
  })

  it('Mod-i wraps the selection in emphasis', async () => {
    const { onChange, editable } = mountEditor()
    await userEvent.click(editable)
    await userEvent.keyboard('slanted')
    await userEvent.keyboard(mod('a'))
    await userEvent.keyboard(mod('i'))
    expect(lastValue(onChange)).toBe('*slanted*')
  })

  it('Mod-b with a collapsed selection inserts delimiters and keeps the cursor between them', async () => {
    const { onChange, editable } = mountEditor()
    await userEvent.click(editable)
    await userEvent.keyboard(mod('b'))
    await userEvent.keyboard('x')
    expect(lastValue(onChange)).toBe('**x**')
  })

  it('long lines soft-wrap instead of scrolling horizontally', async () => {
    const { editable } = mountEditor()
    await userEvent.click(editable)
    await userEvent.keyboard('word '.repeat(80).trim())
    const scroller = document.querySelector('.cm-scroller') as HTMLElement
    expect(scroller.scrollWidth).toBeLessThanOrEqual(scroller.clientWidth + 1)
  })
})
