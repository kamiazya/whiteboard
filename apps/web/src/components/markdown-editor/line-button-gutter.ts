/**
 * The mechanics both in-place projections share for their gutter: one
 * `<button>` marker per line, and the press that opens what it marks.
 *
 * Shared because the two gutters are one interaction, and a fix landing in
 * only one of them is how they came to differ: activation on `mousedown`
 * alone made a tab-focusable button no keyboard could press, in whichever
 * copy kept it.
 */

import type { Text } from '@codemirror/state'
import type { BlockInfo, EditorView } from '@codemirror/view'

/**
 * The placed ranges grouped by the line each STARTS on, lines in document
 * order — the order a `RangeSetBuilder` has to receive them in. Within a
 * line, ranges keep the order they arrived in.
 */
export function bucketByLine<T extends { readonly from: number }>(
  doc: Text,
  placed: readonly T[],
): ReadonlyArray<readonly [lineStart: number, onLine: readonly T[]]> {
  const perLine = new Map<number, T[]>()
  for (const one of placed) {
    const lineStart = doc.lineAt(one.from).from
    const onLine = perLine.get(lineStart)
    if (onLine === undefined) perLine.set(lineStart, [one])
    else onLine.push(one)
  }
  return [...perLine.entries()].sort((a, b) => a[0] - b[0])
}

type GutterHandler = (view: EditorView, line: BlockInfo, event: Event) => boolean

/**
 * The gutter's `domEventHandlers` for markers matching `selector`.
 *
 * The two halves are deliberately split. `mousedown` only holds the caret
 * back — returning true makes CodeMirror `preventDefault` it, so the press
 * neither moves the caret into the line nor takes focus off whatever the
 * activation is about to open, and it does not stop the `click` that
 * follows. The ACTIVATION is on `click`, the event a native button answers
 * to however it was reached: pointer, Enter, or Space.
 *
 * `activate` answers whether the marker it was handed was one it could act
 * on, which is what the handler then returns.
 */
export function buttonGutterHandlers(
  selector: string,
  activate: (marker: HTMLElement) => boolean,
): { readonly mousedown: GutterHandler; readonly click: GutterHandler } {
  const markerOf = (event: Event): HTMLElement | null =>
    event.target instanceof Element ? event.target.closest<HTMLElement>(selector) : null
  return {
    mousedown: (_view, _line, event) => markerOf(event) !== null,
    click: (_view, _line, event) => {
      const marker = markerOf(event)
      return marker !== null && activate(marker)
    },
  }
}
