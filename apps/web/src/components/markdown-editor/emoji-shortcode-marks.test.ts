import { markdown } from '@codemirror/lang-markdown'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { GFM } from '@lezer/markdown'
import { afterEach, describe, expect, it } from 'vitest'
import { emojiShortcodeMarks } from './emoji-shortcode-marks.js'

/**
 * `:rocket:` shown as 🚀 in the SOURCE pane, revealed again while the caret
 * is in it.
 *
 * The rule is "once you have finished writing it": a shortcode the caret is
 * inside is still being typed, so it stays text. Everything else is drawn
 * the way the render will draw it — which is the point, and the reason the
 * ranges come from `emojiShortcodeRanges` rather than a second scanner
 * here.
 */
let view: EditorView | undefined

afterEach(() => {
  view?.destroy()
  view = undefined
  document.body.replaceChildren()
})

/**
 * Mounts a real view; decorations only exist against one.
 *
 * The markdown language is installed because BOTH hosts install it and the
 * code-skipping reads `syntaxTree`. Without it the tree is empty, `inCode`
 * can never fire, and the two code cases below pass a configuration that
 * does not exist — which is exactly what the first version of this file did.
 */
function open(doc: string, caret = 0): EditorView {
  const host = document.createElement('div')
  document.body.append(host)
  view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc,
      selection: { anchor: caret },
      extensions: [markdown({ extensions: [GFM] }), emojiShortcodeMarks()],
    }),
  })
  return view
}

/** The emoji the pane is actually showing, in order. */
const shown = (target: EditorView): string[] =>
  [...target.dom.querySelectorAll('[data-emoji-shortcode]')].map((el) => el.textContent ?? '')

/** The text the pane's content DOM reads as, widgets included. */
const reads = (target: EditorView): string =>
  (target.dom.querySelector('.cm-content')?.textContent ?? '').replaceAll('​', '')

describe('a finished shortcode is drawn as its emoji', () => {
  it('replaces it with the character', () => {
    const target = open('ship it :rocket: today', 0)
    expect(shown(target)).toEqual(['🚀'])
    expect(reads(target)).toBe('ship it 🚀 today')
  })

  it('draws several, and leaves a colon pair that names no emoji alone', () => {
    // Caret at 0 would TOUCH a shortcode starting there, which reveals it —
    // so the doc opens with a word, and the caret sits before all three.
    const target = open('a :fire: and :nope: and :rocket:', 0)
    expect(shown(target)).toEqual(['🔥', '🚀'])
    expect(reads(target)).toContain(':nope:')
  })

  /**
   * The caret is what says "still writing". Inside the shortcode the source
   * comes back, so it can be edited at all — a widget that never yields
   * would make the text unreachable.
   */
  it('shows the source again while the caret is inside it', () => {
    const target = open('ship it :rocket: today', 12)
    expect(shown(target)).toEqual([])
    expect(reads(target)).toBe('ship it :rocket: today')
  })

  it('draws it again once the caret leaves', () => {
    const target = open('ship it :rocket: today', 12)
    expect(shown(target)).toEqual([])
    target.dispatch({ selection: { anchor: 0 } })
    expect(shown(target)).toEqual(['🚀'])
  })

  /**
   * Typing the closing colon is the moment it becomes one, and the caret is
   * then AT the end of it — which must count as still inside, or the emoji
   * appears under the cursor the instant the name completes.
   */
  it('stays text with the caret just past the closing colon', () => {
    const target = open('ship it :rocket:', 16)
    expect(shown(target)).toEqual([])
  })

  /**
   * Inside a code span the shortcode is the SUBJECT, and the renderer says
   * so too — `mdast-blocks.ts` expands text nodes and never `inlineCode`.
   * The editor showing an emoji where the render shows text would make the
   * pane a preview of something that does not happen.
   */
  it('leaves a shortcode inside inline code as text', () => {
    const target = open('type `:rocket:` for it', 0)
    expect(shown(target)).toEqual([])
    expect(reads(target)).toContain(':rocket:')
  })

  it('leaves a shortcode inside a fenced block as text', () => {
    const target = open('```\n:rocket:\n```', 0)
    expect(shown(target)).toEqual([])
  })
})
