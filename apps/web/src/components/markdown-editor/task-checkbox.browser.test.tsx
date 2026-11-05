/**
 * A task checkbox in the preview is a control: clicking the drawn box
 * rewrites its `[ ]` in the source, in Split and in Read alike.
 *
 * A real browser because the box is an unfilled SVG rect, and whether a
 * click lands on it at all is the browser's hit-testing, which jsdom does
 * not do.
 */
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { userEvent } from 'vitest/browser'
import { MarkdownEditor, type MarkdownEditorProps } from './MarkdownEditor.js'

afterEach(cleanup)

const BODY = ['# Plan', '', '- [ ] first', '  - [x] nested', '* [ ] star item'].join('\n')

let latest = BODY
let writes: string[] = []
function Harness({ mode }: { mode: NonNullable<MarkdownEditorProps['initialViewMode']> }) {
  const [value, setValue] = useState(BODY)
  latest = value
  return (
    <MarkdownEditor
      theme="light"
      value={value}
      onChange={(next) => {
        writes.push(next)
        setValue(next)
      }}
      initialViewMode={mode}
      previewDebounceMs={0}
    />
  )
}

const boxes = () => [
  ...document.querySelectorAll('[data-testid="markdown-preview-pane"] [role="checkbox"]'),
]

describe('task checkboxes in the preview', () => {
  for (const mode of ['split', 'read'] as const) {
    it(`toggle their source line on a click in ${mode} mode`, async () => {
      render(<Harness mode={mode} />)
      await expect.poll(() => boxes().length).toBe(3)
      await userEvent.click(boxes()[0] as Element)
      await expect.poll(() => latest).toBe(BODY.replace('- [ ] first', '- [x] first'))
      await expect.poll(() => boxes()[0]?.getAttribute('aria-checked')).toBe('true')
      await userEvent.click(boxes()[1] as Element)
      await expect.poll(() => latest).toContain('  - [ ] nested')
      await userEvent.click(boxes()[2] as Element)
      await expect.poll(() => latest).toContain('* [x] star item')
    })
  }

  it('toggle from the keyboard with Space on a focused box', async () => {
    render(<Harness mode="read" />)
    await expect.poll(() => boxes().length).toBe(3)
    ;(boxes()[2] as SVGElement).focus()
    await userEvent.keyboard(' ')
    await expect.poll(() => latest).toContain('* [x] star item')
  })

  it('names each box from its item, keeps focus through a toggle and announces the result', async () => {
    render(<Harness mode="read" />)
    await expect.poll(() => boxes().length).toBe(3)
    expect(boxes().map((box) => box.getAttribute('aria-label'))).toEqual([
      'first',
      'nested',
      'star item',
    ])
    ;(boxes()[2] as SVGElement).focus()
    await userEvent.keyboard(' ')
    await expect.poll(() => latest).toContain('* [x] star item')
    await expect.poll(() => boxes()[2]?.getAttribute('aria-checked')).toBe('true')
    expect(document.activeElement).toBe(boxes()[2])
    expect(document.activeElement?.getAttribute('aria-label')).toBe('star item')
    await expect
      .poll(() => document.querySelector('[data-testid="task-announcement"]')?.textContent)
      .toBe('star item: checked')
    await userEvent.keyboard(' ')
    await expect
      .poll(() => document.querySelector('[data-testid="task-announcement"]')?.textContent)
      .toBe('star item: not checked')
    expect(document.activeElement).toBe(boxes()[2])
  })
})

describe('a task item in the preview, read on a phone', () => {
  const realMatchMedia = window.matchMedia
  afterEach(() => {
    window.matchMedia = realMatchMedia
  })

  it('toggles when its words are tapped, not only its box', async () => {
    render(<Harness mode="read" />)
    await expect.poll(() => boxes().length).toBe(3)
    const words = [...document.querySelectorAll('[data-testid="markdown-preview-pane"] text')].find(
      (each) => each.textContent === 'first',
    )
    expect(words).toBeDefined()
    await userEvent.click(words as Element)
    await expect.poll(() => latest).toBe(BODY.replace('- [ ] first', '- [x] first'))
  })

  it('takes a coarse tap that lands just beside the box', async () => {
    window.matchMedia = (query: string) =>
      ({
        matches: query === '(pointer: coarse)',
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList
    render(<Harness mode="read" />)
    await expect.poll(() => boxes().length).toBe(3)
    const box = (boxes()[0] as Element).getBoundingClientRect()
    const pane = document.querySelector('[data-testid="markdown-preview-pane"]') as HTMLElement
    const host = pane.getBoundingClientRect()
    await userEvent.click(pane, {
      position: { x: box.left - host.left - 10, y: box.top - host.top + box.height / 2 },
    })
    await expect.poll(() => latest).toBe(BODY.replace('- [ ] first', '- [x] first'))
  })
})

describe('a press near a task item that is not meant for it', () => {
  const wordsOf = (item: string) =>
    [...document.querySelectorAll('[data-testid="markdown-preview-pane"] text')].find(
      (each) => each.textContent === item,
    ) as Element
  // A later toggle that does land proves the earlier press was handled.
  const control = async () => {
    await userEvent.click(boxes()[2] as Element)
    await expect.poll(() => latest).toContain('* [x] star item')
  }

  it('does not toggle from empty space far right of the words', async () => {
    render(<Harness mode="read" />)
    await expect.poll(() => boxes().length).toBe(3)
    const words = wordsOf('first').getBoundingClientRect()
    const pane = document.querySelector('[data-testid="markdown-preview-pane"]') as HTMLElement
    const host = pane.getBoundingClientRect()
    expect(host.right - words.right).toBeGreaterThan(100)
    await userEvent.click(pane, {
      position: { x: words.right - host.left + 80, y: words.top - host.top + words.height / 2 },
    })
    await control()
    expect(latest).toContain('- [ ] first')
  })

  it('toggles once on a double-click on the words', async () => {
    writes = []
    render(<Harness mode="read" />)
    await expect.poll(() => boxes().length).toBe(3)
    await userEvent.dblClick(wordsOf('first'))
    await control()
    expect(latest).toContain('- [x] first')
    expect(writes).toHaveLength(2)
  })

  it('does not take the second click of a double-click on unselectable words', async () => {
    render(<Harness mode="read" />)
    await expect.poll(() => boxes().length).toBe(3)
    const words = wordsOf('first')
    const at = words.getBoundingClientRect()
    fireEvent.click(words, { detail: 2, clientX: at.left + 2, clientY: at.top + at.height / 2 })
    await control()
    expect(latest).toContain('- [ ] first')
  })

  it('does not toggle when the click ends a selection of its words', async () => {
    render(<Harness mode="read" />)
    await expect.poll(() => boxes().length).toBe(3)
    const words = wordsOf('first')
    window.getSelection()?.selectAllChildren(words)
    const at = words.getBoundingClientRect()
    fireEvent.click(words, { detail: 1, clientX: at.left + 2, clientY: at.top + at.height / 2 })
    window.getSelection()?.removeAllRanges()
    await control()
    expect(latest).toContain('- [ ] first')
  })
})
