import { type StateCommand, StateEffect, StateField } from '@codemirror/state'

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

/** Writes `markup` where the upload `token` was held, once; nothing when it is not held. */
export function insertPendingImage(token: string, markup: string): StateCommand {
  return ({ state, dispatch }) => {
    const at = state.field(pendingImages, false)?.get(token)
    if (at === undefined) return false
    dispatch(
      state.update({
        changes: { from: at, insert: markup },
        selection: { anchor: at + markup.length },
        effects: endPending.of(token),
        scrollIntoView: true,
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
