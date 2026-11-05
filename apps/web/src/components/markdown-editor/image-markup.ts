import { type EditorState, type StateCommand, StateEffect, StateField } from '@codemirror/state'

/**
 * What a note's body says for an uploaded picture: an ordinary markdown
 * image whose destination is the keeper's `asset:` reference — the one form
 * the layout draws inline, model's `storedImageRefs` counts as named (so no
 * file collection deletes it), and a markdown export carries as text.
 *
 * The alt text is the file's name, so the source says what the picture is
 * and a reader can edit it there. Brackets and backslashes are dropped
 * rather than escaped: the reference scanner stops at the first `](`, so an
 * escaped `]` would still end the alt early and the picture would not count.
 */
export function imageMarkup(fileName: string, ref: string): string {
  const stem = fileName.replace(/\.[^.]*$/, '')
  const alt = stem
    .replace(/[[\]\\\r\n]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return `![${alt === '' ? 'image' : alt}](${ref})`
}

const startPending = StateEffect.define<{ readonly token: string; readonly at: number }>()
const endPending = StateEffect.define<string>()

/**
 * Where each upload still in flight will land, mapped through every edit
 * made while it uploads. A position held outside the state would point at
 * the wrong character the moment the writer typed above it.
 */
export const pendingImages = StateField.define<ReadonlyMap<string, number>>({
  create: () => new Map(),
  update(value, tr) {
    let next: Map<string, number> | null = null
    const writable = () => {
      next ??= new Map(value)
      return next
    }
    if (tr.docChanged) {
      for (const [token, at] of value) writable().set(token, tr.changes.mapPos(at, -1))
    }
    for (const effect of tr.effects) {
      if (effect.is(startPending)) writable().set(effect.value.token, effect.value.at)
      if (effect.is(endPending)) writable().delete(effect.value)
    }
    return next ?? value
  },
})

/** Holds the caret's position (or `at`, a drop's) for the upload `token`. */
export function startPendingImage(token: string, at?: number): StateCommand {
  return ({ state, dispatch }) => {
    dispatch(
      state.update({ effects: startPending.of({ token, at: at ?? state.selection.main.head }) }),
    )
    return true
  }
}

/** The line breaks that make `at` a block boundary: none, one, or a blank line's two. */
function breaksBefore(state: EditorState, at: number): string {
  if (at === 0) return ''
  const before = state.doc.sliceString(Math.max(0, at - 2), at)
  if (before.endsWith('\n\n')) return ''
  return before.endsWith('\n') ? '\n' : '\n\n'
}

function breaksAfter(state: EditorState, at: number): string {
  if (at === state.doc.length) return ''
  const after = state.doc.sliceString(at, at + 2)
  if (after.startsWith('\n\n')) return ''
  return after.startsWith('\n') ? '\n' : '\n\n'
}

/**
 * Writes `markup` where the upload `token` was held, once; nothing when it is
 * not held.
 *
 * As a block of its own: a picture on the line under a sentence, with no
 * blank line between, is part of that sentence's paragraph to markdown and
 * is drawn inline at its end. A blank line is added before it, and after it
 * when text follows, unless one is already there.
 *
 * The caret follows the picture only when it is still where the picture
 * goes. A writer who kept typing, or moved to another paragraph, while the
 * file uploaded keeps their caret and their scroll position: the selection
 * is mapped through the insert like any other edit.
 */
export function insertPendingImage(token: string, markup: string): StateCommand {
  return ({ state, dispatch }) => {
    const at = state.field(pendingImages, false)?.get(token)
    if (at === undefined) return false
    const caret = state.selection.main
    const caretAtHold = state.selection.ranges.length === 1 && caret.empty && caret.head === at
    const lead = breaksBefore(state, at)
    const insert = `${lead}${markup}${breaksAfter(state, at)}`
    const end = at + lead.length + markup.length
    dispatch(
      state.update({
        changes: { from: at, insert },
        ...(caretAtHold ? { selection: { anchor: end }, scrollIntoView: true } : {}),
        effects: endPending.of(token),
        userEvent: 'input',
      }),
    )
    return true
  }
}

/** Forgets the upload `token` without writing anything — a refused upload. */
export function dropPendingImage(token: string): readonly StateEffect<unknown>[] {
  return [endPending.of(token)]
}
