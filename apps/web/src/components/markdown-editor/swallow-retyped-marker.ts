import type { EditorState, TransactionSpec } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

/**
 * A line holding only an auto-continued marker (`- `, `3. `, `> - `) and
 * the start of the same kind of marker typed over it. Group 1 is the line's
 * own marker including its trailing space, group 2 what was typed after it.
 */
const RETYPED_RE = /^(\s*(?:>\s?)*(?:[-*+]|\d+[.)])[ \t]+)([-*+]|\d+[.)])$/

/** Indentation and quote markers, then the marker's kind — what two sibling items share. */
const SIBLING_RE = /^(\s*(?:>\s?)*)(?:([-*+])|\d+[.)])[ \t]/

/**
 * Typing a space after a marker the user typed by habit over the one the
 * editor already continued onto the line (`- ` then `-`, ` `) would leave
 * `- - `, a nested empty item nobody asked for. The retyped marker and its
 * space are dropped: the line keeps the marker it had. Only a marker of the
 * SAME kind is swallowed, so `- ` followed by `1. ` still starts a numbered
 * item inside the bullet; only at the end of a line with nothing else on
 * it; and only below a sibling item, because a first `- - -` is a divider
 * being typed, not a continuation being repeated.
 */
function swallowRetypedMarker(
  state: EditorState,
  from: number,
  to: number,
  text: string,
): TransactionSpec | null {
  if (text !== ' ' || from !== to) return null
  const line = state.doc.lineAt(from)
  if (from !== line.to) return null
  const match = RETYPED_RE.exec(line.text)
  if (match === null) return null
  const [, own, typed] = match
  const ownIsOrdered = /\d/.test(own)
  if (/\d/.test(typed) !== ownIsOrdered) return null
  if (!ownIsOrdered && !own.includes(typed)) return null
  if (line.number === 1) return null
  const above = SIBLING_RE.exec(state.doc.line(line.number - 1).text)
  const mine = SIBLING_RE.exec(line.text)
  if (above === null || mine === null || above[1] !== mine[1]) return null
  if ((above[2] === undefined) !== ownIsOrdered) return null
  return {
    changes: { from: line.from + own.length, to: line.to, insert: '' },
    selection: { anchor: line.from + own.length },
    userEvent: 'input.type',
  }
}

/** The editor extension that applies `swallowRetypedMarker` to typed text. */
export function swallowRetypedMarkerExtension() {
  return EditorView.inputHandler.of((view, from, to, text) => {
    const spec = swallowRetypedMarker(view.state, from, to, text)
    if (spec === null) return false
    view.dispatch(spec)
    return true
  })
}
