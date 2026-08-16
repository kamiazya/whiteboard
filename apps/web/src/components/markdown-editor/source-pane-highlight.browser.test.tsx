/**
 * SourcePane markdown highlighting (real browser + real stylesheet).
 *
 * `markdown()` only PARSES — without a `syntaxHighlighting` extension the
 * source pane renders every token in one undifferentiated weight and color,
 * so a heading looks exactly like a paragraph.
 *
 * These assert what a reader sees (computed weight/color), not the class
 * names that produce it, so renaming a token class does not fail the test
 * while actually losing the highlighting would.
 */
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MarkdownEditor } from './MarkdownEditor.js'

afterEach(cleanup)

const SAMPLE = ['# Heading', 'plain paragraph text', '**bold** and *slanted*', '`code`'].join('\n')

function mount() {
  render(<MarkdownEditor value={SAMPLE} onChange={vi.fn()} />)
  return document.querySelector('.cm-content') as HTMLElement
}

/**
 * The rendered span carrying `text`, or null when the token is unstyled.
 * Compared trimmed because the space after a `#` belongs to the heading's
 * own text token, so its span reads `" Heading"`, not `"Heading"`.
 */
function spanFor(content: HTMLElement, text: string): HTMLElement | null {
  const spans = Array.from(content.querySelectorAll('span'))
  return (
    (spans.find((span) => span.textContent?.trim() === text) as HTMLElement | undefined) ?? null
  )
}

function weight(el: Element): number {
  return Number.parseInt(getComputedStyle(el).fontWeight, 10)
}

describe('SourcePane markdown highlighting (real browser)', () => {
  it('renders a heading heavier than body text', async () => {
    const content = mount()
    await expect.poll(() => spanFor(content, 'Heading')).not.toBeNull()

    const heading = spanFor(content, 'Heading') as HTMLElement
    const paragraphLine = Array.from(content.querySelectorAll('.cm-line')).find(
      (line) => line.textContent === 'plain paragraph text',
    ) as HTMLElement

    expect(weight(heading)).toBeGreaterThan(weight(paragraphLine))
  })

  it('renders strong and emphasis with their own weight and slant', async () => {
    const content = mount()
    await expect.poll(() => spanFor(content, 'bold')).not.toBeNull()

    const bold = spanFor(content, 'bold') as HTMLElement
    const slanted = spanFor(content, 'slanted') as HTMLElement

    expect(weight(bold)).toBeGreaterThan(400)
    expect(getComputedStyle(slanted).fontStyle).toBe('italic')
  })

  it('recedes the syntax markers behind the text they mark', async () => {
    const content = mount()
    await expect.poll(() => spanFor(content, '#')).not.toBeNull()

    const marker = spanFor(content, '#') as HTMLElement
    const heading = spanFor(content, 'Heading') as HTMLElement

    // Markers are structural noise: they must not read at the same strength
    // as the prose they wrap, or the source pane is louder than the document.
    expect(getComputedStyle(marker).color).not.toBe(getComputedStyle(heading).color)
  })

  // The preview pane parses through codec's pipeline
  // (remark-gfm + remark-math), so a source pane on plain CommonMark
  // silently disagrees with it: GFM constructs render in the preview while
  // staying unrecognized — and therefore unstyled — in the source.
  it('recognizes GFM strikethrough, matching what the preview renders', async () => {
    render(<MarkdownEditor value="~~withdrawn~~" onChange={vi.fn()} />)
    const content = document.querySelector('.cm-content') as HTMLElement
    await expect.poll(() => spanFor(content, 'withdrawn')).not.toBeNull()

    const struck = spanFor(content, 'withdrawn') as HTMLElement
    expect(getComputedStyle(struck).textDecorationLine).toContain('line-through')
  })

  it('recognizes a GFM table delimiter row', async () => {
    render(<MarkdownEditor value={'| a | b |\n| - | - |\n| 1 | 2 |'} onChange={vi.fn()} />)
    const content = document.querySelector('.cm-content') as HTMLElement
    // The delimiter pipes are `processingInstruction` only once the GFM
    // table extension is parsing them.
    await expect.poll(() => content.querySelectorAll('.cm-md-marker').length).toBeGreaterThan(0)
  })

  it('sets inline code in a monospace face', async () => {
    const content = mount()
    await expect.poll(() => spanFor(content, 'code')).not.toBeNull()

    const code = spanFor(content, 'code') as HTMLElement
    expect(getComputedStyle(code).fontFamily.toLowerCase()).toMatch(/mono/)
  })
})
