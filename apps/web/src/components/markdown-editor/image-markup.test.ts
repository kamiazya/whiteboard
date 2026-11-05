// @vitest-environment node
/**
 * The document half of attaching an image to a note: what gets written, and
 * where, once the keeper has stored the file. The intake (picker, paste,
 * drop) is note-image.browser.test.tsx; this is the part a state can answer.
 */
import { EditorSelection, EditorState } from '@codemirror/state'
import { storedImageRefs } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import {
  imageMarkup,
  insertPendingImage,
  pendingImages,
  startPendingImage,
} from './image-markup.js'

describe('imageMarkup', () => {
  it('names the picture after its file, without the extension', () => {
    expect(imageMarkup('meter reading.jpg', 'asset:a1')).toBe('![meter reading](asset:a1)')
  })

  it('keeps the alt text out of the brackets that end it', () => {
    expect(imageMarkup('a [b] \\c.png', 'asset:a1')).toBe('![a b c](asset:a1)')
  })

  it('falls back to a word when the name leaves nothing', () => {
    expect(imageMarkup('.png', 'asset:a1')).toBe('![image](asset:a1)')
  })

  // The keeper's file collection reads the body with `storedImageRefs`; a
  // spelling it does not recognise is a picture a sweep would delete.
  it('writes what the file collection counts as named', () => {
    expect(storedImageRefs({ body: imageMarkup('x [y].png', 'asset:a1') })).toEqual(['asset:a1'])
  })
})

function stateAt(doc: string, caret: number): EditorState {
  return EditorState.create({
    doc,
    selection: EditorSelection.cursor(caret),
    extensions: [pendingImages],
  })
}

function apply(state: EditorState, command: ReturnType<typeof insertPendingImage>): EditorState {
  let next = state
  command({ state, dispatch: (tr) => (next = tr.state) })
  return next
}

describe('a pending image as its own block', () => {
  const insertAt = (doc: string, at: number) => {
    let state = apply(stateAt(doc, at), startPendingImage('t1'))
    state = apply(state, insertPendingImage('t1', '![p](asset:a1)'))
    return state
  }

  it('opens a paragraph of its own after the line it was added on', () => {
    expect(insertAt('Photo below:', 12).doc.toString()).toBe('Photo below:\n\n![p](asset:a1)')
  })

  it('completes a blank line the writer had begun', () => {
    expect(insertAt('Photo below:\n', 13).doc.toString()).toBe('Photo below:\n\n![p](asset:a1)')
  })

  it('adds nothing where a block already starts and ends', () => {
    expect(insertAt('a\n\n\n\nb', 3).doc.toString()).toBe('a\n\n![p](asset:a1)\n\nb')
    expect(insertAt('', 0).doc.toString()).toBe('![p](asset:a1)')
  })

  it('keeps the text after it out of its paragraph', () => {
    const state = insertAt('ab', 1)
    expect(state.doc.toString()).toBe('a\n\n![p](asset:a1)\n\nb')
    expect(state.selection.main.head).toBe('a\n\n![p](asset:a1)'.length)
  })
})

describe('a pending image', () => {
  it('lands where the caret was when the upload started, after edits before it', () => {
    let state = apply(stateAt('ab', 1), startPendingImage('t1'))
    // Typed at the start while the upload runs.
    state = state.update({ changes: { from: 0, insert: 'XY' } }).state
    state = apply(state, insertPendingImage('t1', '![p](asset:a1)'))
    expect(state.doc.toString()).toBe('XYa\n\n![p](asset:a1)\n\nb')
  })

  it('is written once, and a second answer for the same upload writes nothing', () => {
    let state = apply(stateAt('ab', 2), startPendingImage('t1'))
    state = apply(state, insertPendingImage('t1', '![p](asset:a1)'))
    state = apply(state, insertPendingImage('t1', '![p](asset:a1)'))
    expect(state.doc.toString()).toBe('ab\n\n![p](asset:a1)')
  })

  it('leaves a caret that moved on where the writer left it', () => {
    let state = apply(stateAt('ab', 1), startPendingImage('t1'))
    // Typed at the caret while the upload runs: the caret is past the hold.
    state = state.update({ changes: { from: 1, insert: 'XY' }, selection: { anchor: 3 } }).state
    state = apply(state, insertPendingImage('t1', '![p](asset:a1)'))
    expect(state.doc.toString()).toBe('a\n\n![p](asset:a1)\n\nXYb')
    expect(state.selection.main.head).toBe('a\n\n![p](asset:a1)\n\nXY'.length)
  })

  it('puts a caret still at the hold after the picture', () => {
    let state = apply(stateAt('ab', 1), startPendingImage('t1'))
    state = apply(state, insertPendingImage('t1', '![p](asset:a1)'))
    expect(state.selection.main.head).toBe('a\n\n![p](asset:a1)'.length)
  })

  it('starts at an explicit position, as a drop does', () => {
    let state = apply(stateAt('abcd', 0), startPendingImage('t1', 3))
    state = apply(state, insertPendingImage('t1', '!'))
    expect(state.doc.toString()).toBe('abc\n\n!\n\nd')
  })
})
