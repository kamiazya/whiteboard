import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import { swallowRetypedMarkerExtension } from './swallow-retyped-marker.js'

/**
 * Offers `text` at `from`..`to` to the installed input handler, the way the
 * view does for typed text; answers the document when the handler took it
 * and null when it stood aside for the view's own insertion.
 */
function typed(doc: string, from: number, to: number, text: string): string | null {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: EditorSelection.single(to),
      extensions: [swallowRetypedMarkerExtension()],
    }),
  })
  try {
    const handlers = view.state.facet(EditorView.inputHandler)
    const taken = handlers.some((handler) =>
      handler(view, from, to, text, () => view.state.update()),
    )
    return taken ? view.state.doc.toString() : null
  } finally {
    view.destroy()
  }
}

function typeSpace(doc: string, caret = doc.length): string | null {
  return typed(doc, caret, caret, ' ')
}

describe('the retyped-marker input handler', () => {
  it('drops a bullet typed over the continued one, and its space', () => {
    expect(typeSpace('- one\n- -')).toBe('- one\n- ')
    expect(typeSpace('* one\n* *')).toBe('* one\n* ')
    expect(typeSpace('> - one\n> - -')).toBe('> - one\n> - ')
  })

  it('drops a number typed over the continued one', () => {
    expect(typeSpace('1. one\n2. 2.')).toBe('1. one\n2. ')
  })

  it('stands aside for a different kind of marker, so nesting stays possible', () => {
    expect(typeSpace('- one\n- 1.')).toBeNull()
    expect(typeSpace('1. one\n2. -')).toBeNull()
    expect(typeSpace('- one\n- *')).toBeNull()
  })

  it('stands aside without a sibling item above, so a typed divider is left alone', () => {
    expect(typeSpace('- -')).toBeNull()
    expect(typeSpace('text\n- -')).toBeNull()
    expect(typeSpace('  - one\n- -')).toBeNull()
    expect(typeSpace('> - one\n- -')).toBeNull()
  })

  it('stands aside for text after the marker and for a caret mid-line', () => {
    expect(typeSpace('- -x')).toBeNull()
    expect(typeSpace('- -', 2)).toBeNull()
    expect(typeSpace('plain -')).toBeNull()
  })

  it('stands aside for anything but a lone space', () => {
    expect(typed('- one\n- -', 9, 9, 'x')).toBeNull()
    expect(typed('- one\n- -', 8, 9, ' ')).toBeNull()
  })
})
