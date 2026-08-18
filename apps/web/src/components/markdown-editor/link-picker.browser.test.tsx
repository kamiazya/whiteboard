// One verb, one surface: the search box decides whether you are linking to a
// document in this workspace or to a URL. Nothing asks the author to classify
// the destination before they have typed it.
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import type { LinkTarget } from './link-target.js'
import { MarkdownEditor } from './MarkdownEditor.js'

afterEach(() => {
  cleanup()
  window.localStorage.clear()
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
  await userEvent.click(getByRole('button', { name: 'More actions' }))
  await userEvent.click(getByRole('menuitem', { name: 'Link' }))
  return container.querySelector('[data-testid="link-picker"]') as HTMLElement
}

type RenderResult = ReturnType<typeof render>

describe('the link picker (real browser)', () => {
  it("seeds the search box with the caret's word, so the fast path stays one Enter", async () => {
    const onChange = vi.fn()
    const { container, getByRole } = render(
      <MarkdownEditor value="see weekly notes" onChange={onChange} linkTargets={targets} />,
    )
    await caretInto(container, 6) // inside "weekly"

    const picker = await openPicker(container, getByRole)
    expect(picker).not.toBeNull()
    expect((picker.querySelector('input') as HTMLInputElement).value).toBe('weekly')

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
    const input = picker.querySelector('input') as HTMLInputElement
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
    const input = picker.querySelector('input') as HTMLInputElement
    await userEvent.clear(input)
    await userEvent.fill(input, 'untitled')
    await userEvent.click(picker.querySelectorAll('[role="option"]')[0] as HTMLElement)

    expect(onChange.mock.calls.at(-1)?.[0]).toBe('[[canvas:01JDUPE1]]')
  })

  it('offers the URL when what you typed is one', async () => {
    const onChange = vi.fn()
    const { container, getByRole } = render(
      <MarkdownEditor value="the docs" onChange={onChange} linkTargets={targets} />,
    )
    await caretInto(container, 5) // inside "docs"

    const picker = await openPicker(container, getByRole)
    const input = picker.querySelector('input') as HTMLInputElement
    await userEvent.clear(input)
    await userEvent.fill(input, 'https://example.com/guide')

    const first = picker.querySelector('[role="option"]') as HTMLElement
    expect(first.textContent).toContain('https://example.com/guide')
    await userEvent.click(first)

    expect(onChange.mock.calls.at(-1)?.[0]).toBe('the [docs](https://example.com/guide)')
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

    await userEvent.click(getByRole('button', { name: 'More actions' }))
    await userEvent.click(getByRole('menuitem', { name: 'Link' }))

    expect(container.querySelector('[data-testid="link-picker"]')).toBeNull()
    expect(onChange.mock.calls.at(-1)?.[0]).toBe('see [[weekly]] notes')
  })
})
