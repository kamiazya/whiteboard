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
import { useReferenceSeams } from '../../hooks/use-reference-seams.js'
import { MarkdownEditor, type MarkdownEditorProps } from './MarkdownEditor.js'

afterEach(cleanup)

const BODY = ['# Plan', '', '- [ ] first', '  - [x] nested', '* [ ] star item'].join('\n')

let latest = BODY
let writes: string[] = []
function Harness({
  mode,
  debounced = false,
}: {
  mode: NonNullable<MarkdownEditorProps['initialViewMode']>
  /** Keep the editor's own preview debounce, as the app does, rather than 0. */
  debounced?: boolean
}) {
  const [value, setValue] = useState(BODY)
  latest = value
  // The page's seams follow the body at once, while the preview's text waits
  // out the debounce — so the preview redraws twice for one tick.
  const references = useReferenceSeams({ body: value, load: async () => undefined })
  return (
    <MarkdownEditor
      theme="light"
      value={value}
      onChange={(next) => {
        writes.push(next)
        setValue(next)
      }}
      initialViewMode={mode}
      {...(debounced ? { references } : { previewDebounceMs: 0 })}
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

describe('a task ticked in Split while the preview waits out its debounce', () => {
  it('announces the NEW state and keeps focus on the box once it redraws', async () => {
    render(<Harness mode="split" debounced />)
    await expect.poll(() => boxes().length).toBe(3)
    ;(boxes()[0] as SVGElement).focus()
    await userEvent.keyboard(' ')
    await expect.poll(() => latest).toContain('- [x] first')
    await expect.poll(() => boxes()[0]?.getAttribute('aria-checked')).toBe('true')
    await expect
      .poll(() => document.querySelector('[data-testid="task-announcement"]')?.textContent)
      .toBe('first: checked')
    expect(document.activeElement?.getAttribute('aria-label')).toBe('first')
    expect(document.activeElement).toBe(boxes()[0])
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

describe('a task box pressed while the source is ahead of the preview', () => {
  function SlowPreview() {
    const [value, setValue] = useState(BODY)
    latest = value
    // Long enough that every keystroke below lands inside the debounce.
    return (
      <MarkdownEditor
        theme="light"
        value={value}
        onChange={setValue}
        initialViewMode="split"
        previewDebounceMs={60_000}
      />
    )
  }

  it('leaves focus in the source while typing continues', async () => {
    render(<SlowPreview />)
    await expect.poll(() => boxes().length).toBe(3)
    const source = document.querySelector('.cm-content') as HTMLElement
    source.focus()
    await userEvent.keyboard('a')
    await expect.poll(() => latest).toContain('a')
    // Dropped: the preview's lines are older than the body.
    await userEvent.click(boxes()[0] as Element)
    source.focus()
    await userEvent.keyboard('bc')
    await expect.poll(() => latest).toContain('ab')
    expect(source.contains(document.activeElement)).toBe(true)
    expect(latest).toContain('- [ ] first')
  })

  it('stops waiting on a toggle once focus moves to the source', async () => {
    render(<SlowPreview />)
    await expect.poll(() => boxes().length).toBe(3)
    // Lands in the body; the preview will not redraw it for a minute.
    await userEvent.click(boxes()[0] as Element)
    await expect.poll(() => latest).toContain('- [x] first')
    const source = document.querySelector('.cm-content') as HTMLElement
    source.focus()
    await userEvent.keyboard('yz')
    await expect.poll(() => latest).toContain('yz')
    expect(source.contains(document.activeElement)).toBe(true)
  })
})
