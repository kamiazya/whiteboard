/**
 * The toggle reads the nest around the caret from BOTH sides, so `**a** word` is not a bold
 * `word`. The two property files beside this one hold the algebra; these are the examples the
 * nest comment in `editor-verbs.ts` promises.
 */
import { EditorSelection, EditorState } from '@codemirror/state'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type ActiveMarkdownEditor,
  clearActiveMarkdownEditor,
  setActiveMarkdownEditor,
} from './active-markdown-editor.js'
import { markdownStyleKeymap, selfContainedCommand, verb } from './editor-verbs.js'

function run(doc: string, caret: number): string {
  let state = EditorState.create({ doc, selection: EditorSelection.cursor(caret) })
  const command = selfContainedCommand(verb('bold'))
  if (command === null) throw new Error('bold has no self-contained command')
  command({ state, dispatch: (tr) => (state = tr.state) })
  return state.doc.toString()
}

describe('the bold toggle', () => {
  it('wraps a word that merely follows a bold one', () => {
    expect(run('**a** word', 8)).toBe('**a** **word**')
  })

  it('wraps a word that merely precedes a bold one', () => {
    expect(run('word **a**', 2)).toBe('**word** **a**')
  })

  it('strips the bold from a word that is inside one', () => {
    expect(run('**word**', 4)).toBe('word')
  })

  it('does not take an unmatched opener, or an unmatched closer, for a pair', () => {
    expect(run('**word', 4)).toBe('****word**')
    expect(run('word**', 2)).toBe('**word****')
  })
})

describe('the link chord', () => {
  const chord = () => markdownStyleKeymap.find((binding) => binding.key === 'Mod-k')
  const handle = (openLinkPicker?: () => boolean): ActiveMarkdownEditor => ({
    run: () => {},
    headingLevel: () => 0,
    focus: () => {},
    selectedRange: () => null,
    ...(openLinkPicker === undefined ? {} : { openLinkPicker }),
  })
  const target = (doc: string) => {
    let state = EditorState.create({ doc, selection: EditorSelection.single(0, doc.length) })
    return {
      get doc() {
        return state.doc.toString()
      },
      view: {
        state,
        dispatch: (tr: { state: EditorState }) => {
          state = tr.state
        },
      },
    }
  }
  let registered: ActiveMarkdownEditor | null = null
  const register = (editor: ActiveMarkdownEditor) => {
    registered = editor
    setActiveMarkdownEditor(editor)
  }
  afterEach(() => {
    if (registered !== null) clearActiveMarkdownEditor(registered)
    registered = null
  })

  it("is the link verb's own key, derived from the table", () => {
    expect(verb('link').key).toBe('Mod-k')
    expect(chord()).toBeDefined()
  })

  it("opens the focused editor's link picker instead of writing", () => {
    const open = vi.fn(() => true)
    register(handle(open))
    const t = target('word')
    expect(chord()?.run(t.view)).toBe(true)
    expect(open).toHaveBeenCalledOnce()
    expect(t.doc).toBe('word')
  })

  it('degrades to the bracket wrap where there is no picker to open', () => {
    register(handle(() => false))
    const t = target('word')
    expect(chord()?.run(t.view)).toBe(true)
    expect(t.doc).toBe('[[word]]')
  })
})
