import type { EditorState, StateCommand } from '@codemirror/state'

/**
 * A leading run of 1-6 `#` FOLLOWED BY whitespace — the space is what makes
 * it a heading rather than a tag, so `#tag` reads as body text. Captured in
 * one group with the space so the replacement can normalize a multi-space
 * run back to exactly one.
 */
const HEADING_RE = /^(#{1,6})\s+/

const MAX_LEVEL = 6

/** The heading level of the line holding the selection's start; 0 for body text. */
export function headingLevelAt(state: EditorState): number {
  const line = state.doc.lineAt(state.selection.main.from)
  return HEADING_RE.exec(line.text)?.[1].length ?? 0
}

/**
 * Sets every line the selection covers to `level` (0 = body text), the same
 * line-anchored text matching `toggleTaskCheckbox` uses and for the same
 * reason: a heading marker is only ever hashes plus a space at line start,
 * and text matching beats lexer work for something this shallow.
 *
 * Blank lines are skipped — a bare `#` on an empty line is a marker with
 * nothing to mark, and demoting it later would have nothing to strip.
 * Reports unhandled when nothing would change, so a keybinding can fall
 * through and a menu item cannot silently no-op.
 */
export function setHeadingLevel(level: number): StateCommand {
  return ({ state, dispatch }) => {
    if (!Number.isInteger(level) || level < 0 || level > MAX_LEVEL) return false
    const lineNumbers = new Set<number>()
    for (const range of state.selection.ranges) {
      const first = state.doc.lineAt(range.from).number
      const last = state.doc.lineAt(range.to).number
      for (let n = first; n <= last; n++) lineNumbers.add(n)
    }
    const changes: { from: number; to: number; insert: string }[] = []
    for (const n of lineNumbers) {
      const line = state.doc.line(n)
      if (line.text.trim() === '') continue
      const match = HEADING_RE.exec(line.text)
      const current = match?.[1].length ?? 0
      const marker = match?.[0].length ?? 0
      if (current === level && (match === null || match[0] === `${'#'.repeat(level)} `)) continue
      changes.push({
        from: line.from,
        to: line.from + marker,
        insert: level === 0 ? '' : `${'#'.repeat(level)} `,
      })
    }
    if (changes.length === 0) return false
    dispatch(state.update({ changes, userEvent: 'input' }))
    return true
  }
}
