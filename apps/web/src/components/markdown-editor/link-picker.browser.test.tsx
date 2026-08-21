// One verb, one surface: the search box decides whether you are linking to a
// document in this workspace or to a URL. Nothing asks the author to classify
// the destination before they have typed it.
import { cleanup, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import type { LinkTarget } from './link-target.js'
import { MarkdownEditor } from './MarkdownEditor.js'

afterEach(() => {
  cleanup()
  window.localStorage.removeItem('whiteboard.markdown-view-mode')
})

const targets: readonly LinkTarget[] = [
  { id: '01JWEEK', name: 'Weekly review', kind: 'markdown' },
  { id: '01JSPRINT', name: 'Sprint board', kind: 'spatial' },
  { id: '01JDUPE1', name: 'untitled', kind: 'markdown' },
  { id: '01JDUPE2', name: 'untitled', kind: 'markdown' },
]

async function caretInto(container: HTMLElement, right: number): Promise<void> {
  const editable = container
    .querySelector('[data-testid="markdown-source-pane"]')
    ?.querySelector('[contenteditable="true"]')
  if (!editable) throw new Error('expected a contenteditable CodeMirror host')
  await userEvent.click(editable.querySelector('.cm-line') as HTMLElement)
  await userEvent.keyboard('{Control>}{Home}{/Control}')
  for (let i = 0; i < right; i++) await userEvent.keyboard('{ArrowRight}')
}

async function openPicker(container: HTMLElement, getByRole: RenderResult['getByRole']) {
  await userEvent.click(getByRole('button', { name: 'Editing actions' }))
  await userEvent.click(getByRole('menuitem', { name: 'Link' }))
  return container.querySelector('[data-testid="link-picker"]') as HTMLElement
}

type RenderResult = ReturnType<typeof render>

/**
 * A host that actually keeps what is typed. The other cases can pass a fixed
 * `value` because they make exactly one edit, but a case that types INTO the
 * document mid-flow needs the controlled value to follow — otherwise
 * SourcePane's reconcile effect rewinds the typing before the assertion.
 */
function StatefulHost({
  initial,
  onChange,
}: {
  initial: string
  onChange: (next: string) => void
}) {
  const [value, setValue] = useState(initial)
  return (
    <MarkdownEditor
      value={value}
      onChange={(next) => {
        setValue(next)
        onChange(next)
      }}
      linkTargets={targets}
    />
  )
}

describe('the link picker (real browser)', () => {
  it("seeds the search box with the caret's word, so the fast path stays one Enter", async () => {
    const onChange = vi.fn()
    const { container, getByRole } = render(
      <MarkdownEditor value="see weekly notes" onChange={onChange} linkTargets={targets} />,
    )
    await caretInto(container, 6) // inside "weekly"

    const picker = await openPicker(container, getByRole)
    expect(picker).not.toBeNull()
    expect((picker.querySelector('#link-picker-search') as HTMLInputElement).value).toBe('weekly')

    await userEvent.keyboard('{Enter}')
    expect(onChange.mock.calls.at(-1)?.[0]).toBe('see [[Weekly review]] notes')
  })

  it('narrows as you type and links what you pick', async () => {
    const onChange = vi.fn()
    const { container, getByRole } = render(
      <MarkdownEditor value="x" onChange={onChange} linkTargets={targets} />,
    )
    await caretInto(container, 1)

    const picker = await openPicker(container, getByRole)
    const input = picker.querySelector('#link-picker-search') as HTMLInputElement
    await userEvent.clear(input)
    await userEvent.fill(input, 'sprint')

    const options = picker.querySelectorAll('[role="option"]')
    expect(options).toHaveLength(1)
    await userEvent.click(options[0] as HTMLElement)
    expect(onChange.mock.calls.at(-1)?.[0]).toBe('[[Sprint board]]')
  })

  // The picker is the one place that knows WHICH document was chosen, so it
  // spends that knowledge on the ambiguous case instead of writing a link
  // that would silently stay literal text.
  it('writes the id when two documents share a name', async () => {
    const onChange = vi.fn()
    const { container, getByRole } = render(
      <MarkdownEditor value="x" onChange={onChange} linkTargets={targets} />,
    )
    await caretInto(container, 1)

    const picker = await openPicker(container, getByRole)
    const input = picker.querySelector('#link-picker-search') as HTMLInputElement
    await userEvent.clear(input)
    await userEvent.fill(input, 'untitled')
    await userEvent.click(picker.querySelectorAll('[role="option"]')[0] as HTMLElement)

    // The id resolves; the alias is what makes it readable.
    expect(onChange.mock.calls.at(-1)?.[0]).toBe('[[01JDUPE1|untitled]]')
  })

  it('offers the URL when what you typed is one', async () => {
    const onChange = vi.fn()
    const { container, getByRole } = render(
      <MarkdownEditor value="the docs" onChange={onChange} linkTargets={targets} />,
    )
    await caretInto(container, 5) // inside "docs"

    const picker = await openPicker(container, getByRole)
    const input = picker.querySelector('#link-picker-search') as HTMLInputElement
    await userEvent.clear(input)
    await userEvent.fill(input, 'https://example.com/guide')

    const first = picker.querySelector('[role="option"]') as HTMLElement
    expect(first.textContent).toContain('https://example.com/guide')
    await userEvent.click(first)

    expect(onChange.mock.calls.at(-1)?.[0]).toBe('the [docs](https://example.com/guide)')
  })

  // The dialog is not modal, so the caret can move under it — and the range
  // the verb showed you is the range it must write to. Re-deriving it at
  // commit time splices the markup wherever the caret ended up, silently
  // destroying whatever was there.
  it('writes to the range it was opened for, even if the caret moved meanwhile', async () => {
    const onChange = vi.fn()
    const { container, getByRole } = render(
      <MarkdownEditor value="weekly beta" onChange={onChange} linkTargets={targets} />,
    )
    await caretInto(container, 3) // inside "weekly"

    const picker = await openPicker(container, getByRole)
    expect((picker.querySelector('#link-picker-search') as HTMLInputElement).value).toBe('weekly')

    // Back into the document, caret to the end, then pick from the still-open
    // dialog.
    const editable = container.querySelector('[contenteditable="true"]') as HTMLElement
    await userEvent.click(editable.querySelector('.cm-line') as HTMLElement)
    await userEvent.keyboard('{Control>}{End}{/Control}')
    await userEvent.click(container.querySelectorAll('[role="option"]')[0] as HTMLElement)

    expect(onChange.mock.calls.at(-1)?.[0]).toBe('[[Weekly review]] beta')
  })

  // Pinning an offset is not enough: text typed BEFORE it shifts every later
  // position, so the pin has to travel with the document, not just survive it.
  it('follows its range when text is inserted before it', async () => {
    const onChange = vi.fn()
    const { container, getByRole } = render(
      <StatefulHost initial="weekly beta" onChange={onChange} />,
    )
    await caretInto(container, 3) // inside "weekly"

    const picker = await openPicker(container, getByRole)
    expect((picker.querySelector('#link-picker-search') as HTMLInputElement).value).toBe('weekly')

    // Type at the very start of the document while the picker is open.
    const editable = container.querySelector('[contenteditable="true"]') as HTMLElement
    await userEvent.click(editable.querySelector('.cm-line') as HTMLElement)
    await userEvent.keyboard('{Control>}{Home}{/Control}')
    await userEvent.keyboard('SEE ')
    await userEvent.click(container.querySelectorAll('[role="option"]')[0] as HTMLElement)

    expect(onChange.mock.calls.at(-1)?.[0]).toBe('SEE [[Weekly review]] beta')
  })

  it('moves the highlight with the arrow keys and commits the active row', async () => {
    const onChange = vi.fn()
    const { container, getByRole } = render(
      <MarkdownEditor value="x" onChange={onChange} linkTargets={targets} />,
    )
    await caretInto(container, 1)

    const picker = await openPicker(container, getByRole)
    const input = picker.querySelector('#link-picker-search') as HTMLInputElement
    await userEvent.clear(input)
    await userEvent.fill(input, 'untitled')
    await userEvent.keyboard('{ArrowDown}')

    const options = picker.querySelectorAll('[role="option"]')
    expect(options[1]?.getAttribute('aria-selected')).toBe('true')
    await userEvent.keyboard('{Enter}')

    expect(onChange.mock.calls.at(-1)?.[0]).toBe('[[01JDUPE2|untitled]]')
  })

  it('says so when nothing matches, and Enter does nothing', async () => {
    const onChange = vi.fn()
    const { container, getByRole } = render(
      <MarkdownEditor value="x" onChange={onChange} linkTargets={targets} />,
    )
    await caretInto(container, 1)

    const picker = await openPicker(container, getByRole)
    const input = picker.querySelector('#link-picker-search') as HTMLInputElement
    await userEvent.clear(input)
    await userEvent.fill(input, 'nothing by this name')

    expect(picker.querySelectorAll('[role="option"]')).toHaveLength(0)
    expect(picker.textContent).toContain('No document matches')
    await userEvent.keyboard('{Enter}')
    expect(onChange).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="link-picker"]')).not.toBeNull()
  })

  it('uses the display-text field for both kinds of link', async () => {
    const onChange = vi.fn()
    const { container, getByRole } = render(
      <MarkdownEditor value="see weekly notes" onChange={onChange} linkTargets={targets} />,
    )
    await caretInto(container, 6) // inside "weekly"

    const picker = await openPicker(container, getByRole)
    // Empty by default — its placeholder shows what will be used instead, so
    // leaving it alone reproduces the pre-field behaviour.
    const display = picker.querySelector('#link-picker-text') as HTMLInputElement
    expect(display.value).toBe('')
    expect(display.placeholder).toBe('Weekly review')

    await userEvent.fill(display, 'last week')
    await userEvent.click(picker.querySelectorAll('[role="option"]')[0] as HTMLElement)

    expect(onChange.mock.calls.at(-1)?.[0]).toBe('see [[Weekly review|last week]] notes')
  })

  it('applies the display text to an external link too', async () => {
    const onChange = vi.fn()
    const { container, getByRole } = render(
      <MarkdownEditor value="x" onChange={onChange} linkTargets={targets} />,
    )
    await caretInto(container, 1)

    const picker = await openPicker(container, getByRole)
    const search = picker.querySelector('#link-picker-search') as HTMLInputElement
    await userEvent.clear(search)
    await userEvent.fill(search, 'https://example.com/guide')
    const display = picker.querySelector('#link-picker-text') as HTMLInputElement
    // For a URL the default is the text that was already there.
    expect(display.placeholder).toBe('x')
    await userEvent.fill(display, 'the guide')
    await userEvent.click(picker.querySelector('[role="option"]') as HTMLElement)

    expect(onChange.mock.calls.at(-1)?.[0]).toBe('[the guide](https://example.com/guide)')
  })

  // With the caret on whitespace there is no word to carry the link, so an
  // external one degrades to a bare autolink — the placeholder has to say so
  // rather than showing an empty default.
  it('says the URL will carry itself when there is no text to use', async () => {
    const { container, getByRole } = render(
      <MarkdownEditor value="a  b" onChange={() => {}} linkTargets={targets} />,
    )
    await caretInto(container, 2) // the gap between the words

    const picker = await openPicker(container, getByRole)
    const search = picker.querySelector('#link-picker-search') as HTMLInputElement
    await userEvent.fill(search, 'https://example.com')

    const display = picker.querySelector('#link-picker-text') as HTMLInputElement
    expect(display.placeholder).toBe('The URL itself')
  })

  it('closes on Escape without touching the document', async () => {
    const onChange = vi.fn()
    const { container, getByRole } = render(
      <MarkdownEditor value="untouched" onChange={onChange} linkTargets={targets} />,
    )
    await caretInto(container, 3)

    await openPicker(container, getByRole)
    await userEvent.keyboard('{Escape}')

    expect(container.querySelector('[data-testid="link-picker"]')).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
  })

  // Without a host-supplied list there is nothing to pick from, and a picker
  // that opens onto an empty list is a dead end — the verb keeps its
  // selection-free wrap instead.
  it('falls back to wrapping the word when the host supplies no targets', async () => {
    const onChange = vi.fn()
    const { container, getByRole } = render(
      <MarkdownEditor value="see weekly notes" onChange={onChange} />,
    )
    await caretInto(container, 6)

    await userEvent.click(getByRole('button', { name: 'Editing actions' }))
    await userEvent.click(getByRole('menuitem', { name: 'Link' }))

    expect(container.querySelector('[data-testid="link-picker"]')).toBeNull()
    expect(onChange.mock.calls.at(-1)?.[0]).toBe('see [[weekly]] notes')
  })
})
