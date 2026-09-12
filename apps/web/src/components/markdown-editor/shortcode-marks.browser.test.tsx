/**
 * `:rocket:` drawn as 🚀 in the two places a person WRITES markdown, in a
 * real browser.
 *
 * `emoji-shortcode-marks.test.ts` builds its own view, so it can only say
 * the extension works. What breaks here is the WIRING — an extension that
 * never reaches a host's array, or reaches one host and not the other, and
 * then a note drawn one way in the document editor and another on the
 * canvas. Both hosts are mounted for real for that reason.
 */
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { SpatialEditor } from '../spatial-editor/SpatialEditor.js'
import { MarkdownEditor } from './MarkdownEditor.js'

afterEach(cleanup)

/** The emoji the surface is actually showing, in order. */
const shown = (): string[] =>
  [...document.querySelectorAll('[data-emoji-shortcode]')].map((el) => el.textContent ?? '')

describe('a finished shortcode is drawn as its emoji while writing', () => {
  it('draws it in the document editor and leaves the code span alone', async () => {
    render(
      <MarkdownEditor value={'ship it :rocket: today\n\nnot `:fire:` though'} onChange={vi.fn()} />,
    )
    await expect.poll(shown).toEqual(['🚀'])

    const content = document.querySelector('.cm-content') as HTMLElement
    expect(content.textContent).toContain(':fire:')
  })

  /**
   * The reveal rule, through real keystrokes: a name being typed is still
   * text, and becomes its emoji only once the caret leaves it. Typed rather
   * than dispatched because the caret is the whole subject.
   */
  it('keeps the name as text while it is being typed and draws it once the caret leaves', async () => {
    render(<MarkdownEditor value={'ship it '} onChange={vi.fn()} />)
    const content = document.querySelector('.cm-content') as HTMLElement
    await userEvent.click(content)
    // Escape closes the `:` completion popup this typing opens; the popup is
    // another module's subject and an open one would own the arrow key below.
    await userEvent.keyboard(':rocket:')
    // The caret is AT the closing colon the instant the name is finished,
    // which the reveal rule counts as still inside — so the name is still
    // text here, and typing on is what moves the caret out of it.
    expect(shown()).toEqual([])

    await userEvent.keyboard(' today')
    await expect.poll(shown).toEqual(['🚀'])
  })

  /**
   * Clicking the emoji is the one obvious gesture for "let me edit this", so
   * it has to land the caret in the shortcode and bring the text back.
   *
   * It does NOT rest on the widget's `ignoreEvent`: overriding that to `false`
   * was written here first with a comment claiming it was load-bearing, and
   * the mutation refutes it — this case passes at the default too, because
   * CodeMirror maps the resulting DOM selection to a document position either
   * way. The override went, and the behaviour is pinned rather than the
   * mechanism guessed at.
   */
  it('brings the source back when the emoji itself is clicked', async () => {
    render(<MarkdownEditor value={'ship it :rocket: today'} onChange={vi.fn()} />)
    await expect.poll(shown).toEqual(['🚀'])

    await userEvent.click(document.querySelector('[data-emoji-shortcode]') as HTMLElement)
    await expect.poll(shown).toEqual([])
  })

  it('draws it in a canvas node editor too', async () => {
    const canvas: SpatialCanvas = {
      // Text AFTER the shortcode on purpose: opening the editor puts the
      // caret at the end of the body (measured, offset 11 on 'go :rocket:'),
      // which is the closing colon itself and therefore still revealed.
      nodes: [
        {
          id: 'n1',
          type: 'text',
          x: 100,
          y: 100,
          width: 260,
          height: 120,
          text: 'go :rocket: now',
        },
      ],
      edges: [],
    }
    const { container } = render(
      <div style={{ width: 800, height: 600 }}>
        <SpatialEditor defaultTool="select" canvas={canvas} onChange={vi.fn()} theme="light" />
      </div>,
    )
    const root = container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
    const r = root.getBoundingClientRect()
    const at = { clientX: r.left + 200, clientY: r.top + 150 }
    for (const _ of [0, 1]) {
      fireEvent.pointerDown(root, { button: 0, pointerId: 1, ...at })
      fireEvent.pointerUp(root, { pointerId: 1, ...at })
    }

    await expect.poll(() => document.querySelector('.cm-content')).not.toBeNull()
    await expect.poll(shown).toEqual(['🚀'])
  })
})
