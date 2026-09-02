import type { StateCommand } from '@codemirror/state'

/**
 * The three line-anchored list/quote prefixes the bar toggles. Text
 * matching, like `setHeadingLevel` and `toggleTaskCheckbox`: a marker is
 * only ever a short run at line start after indentation, and a lexer buys
 * nothing here.
 */
export type LinePrefixKind = 'bullet' | 'ordered' | 'quote'

const MATCHERS: Record<LinePrefixKind, RegExp> = {
  bullet: /^(\s*)[-*+]\s+/,
  ordered: /^(\s*)\d+[.)]\s+/,
  quote: /^(\s*)>\s?/,
}

const INSERTS: Record<LinePrefixKind, (index: number) => string> = {
  bullet: () => '- ',
  ordered: (index) => `${index + 1}. `,
  quote: () => '> ',
}

/**
 * Toggles a prefix over the non-blank lines the selection covers. When
 * EVERY such line already carries it, the prefix is stripped (indentation
 * kept); otherwise the lines lacking it gain one, numbered in order for an
 * ordered list. Applying it twice to prefix-free lines is therefore the
 * identity, which is the invariant the property test states. Blank lines
 * are skipped, and a selection covering only blank lines is unhandled so a
 * menu item cannot silently no-op.
 */
export function toggleLinePrefix(kind: LinePrefixKind): StateCommand {
  const matcher = MATCHERS[kind]
  const insertFor = INSERTS[kind]
  return ({ state, dispatch }) => {
    const lineNumbers = new Set<number>()
    for (const range of state.selection.ranges) {
      const first = state.doc.lineAt(range.from).number
      const last = state.doc.lineAt(range.to).number
      for (let n = first; n <= last; n++) lineNumbers.add(n)
    }
    const lines = [...lineNumbers]
      .sort((a, b) => a - b)
      .map((n) => state.doc.line(n))
      .filter((line) => line.text.trim() !== '')
    if (lines.length === 0) return false
    const matches = lines.map((line) => matcher.exec(line.text))
    const everyLineHasIt = matches.every((match) => match !== null)
    const changes: { from: number; to: number; insert: string }[] = []
    if (everyLineHasIt) {
      lines.forEach((line, i) => {
        const match = matches[i]
        if (match === null) return
        const indent = match[1].length
        changes.push({ from: line.from + indent, to: line.from + match[0].length, insert: '' })
      })
    } else {
      let index = 0
      lines.forEach((line, i) => {
        if (matches[i] !== null) return
        const indent = /^\s*/.exec(line.text)?.[0].length ?? 0
        changes.push({ from: line.from + indent, to: line.from + indent, insert: insertFor(index) })
        index += 1
      })
    }
    if (changes.length === 0) return false
    dispatch(state.update({ changes, userEvent: 'input' }))
    return true
  }
}
