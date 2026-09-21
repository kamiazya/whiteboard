// @vitest-environment node
/**
 * Indent and outdent are inverses ON THE MOVE THEY MAKE.
 *
 * `nestingIndent` is the one verb here whose meaning comes from the lines
 * ABOVE — a child starts at its parent's CONTENT column, so the width is
 * the sibling's marker (`1. ` is three wide, `- ` two) rather than a fixed
 * unit. Thirty example tests cover the cases somebody thought of; what no
 * example can state is that the pair composes, which is the property a
 * person actually relies on when they press Tab and change their mind.
 *
 * Stated as a CONDITIONAL inverse, because neither verb is total: indenting
 * a line with no sibling above it is refused (there is nothing to nest
 * under, and a bare unit of indent is whitespace the parser ignores), and
 * outdenting at the margin has nowhere shallower to go. The claim is that
 * WHEN indent moves a line, outdent puts it back.
 */
import { EditorSelection, EditorState, type StateCommand } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { fc, fcTest, withDefaults } from '../../test-utils/fast-check.js'
import { changeIndent } from './line-prefix.js'

const indent = changeIndent(1)
const outdent = changeIndent(-1)

/** Runs a command at `anchor`, answering the new doc or null if refused. */
function run(command: StateCommand, doc: string, anchor: number): string | null {
  const state = EditorState.create({ doc, selection: EditorSelection.single(anchor) })
  let next: string | null = null
  const handled = command({
    state,
    dispatch: (tr) => {
      next = tr.state.doc.toString()
    },
  })
  return handled ? next : null
}

/** The offset of the first character of a 1-based line. */
function startOf(doc: string, lineNumber: number): number {
  const lines = doc.split('\n')
  return lines.slice(0, lineNumber - 1).reduce((sum, line) => sum + line.length + 1, 0)
}

/**
 * A list document: marker kinds and indents drawn independently, because a
 * WELL-FORMED tree is exactly the case the examples already cover. What
 * finds the interesting moves is a ragged one — a line indented under a
 * sibling that is itself deeper, an ordered item under a bullet, a blank
 * line between two items (which the sibling walk skips).
 */
const listDoc = fc
  .array(
    fc.record({
      indent: fc.nat({ max: 3 }).map((n) => ' '.repeat(n * 2)),
      // CANONICAL markers only. `renderPrefix` rewrites every bullet to
      // `- ` and every ordered marker to `N. `, so a `* ` item drawn here
      // would fail this property for a reason that is not about indenting
      // at all. That rewrite is real and is pinned as an example below,
      // rather than hidden by loosening the comparison.
      marker: fc.constantFrom('- ', '1. ', '2. ', ''),
      text: fc.constantFrom('alpha', 'beta', ''),
    }),
    { minLength: 2, maxLength: 5 },
  )
  .map((lines) => lines.map((l) => `${l.indent}${l.marker}${l.text}`).join('\n'))

describe('indent and outdent compose', () => {
  fcTest.prop([listDoc, fc.nat({ max: 4 })], withDefaults())(
    'outdent puts back whatever indent moved',
    (doc, lineIndex) => {
      const lineCount = doc.split('\n').length
      const lineNumber = (lineIndex % lineCount) + 1
      const caret = startOf(doc, lineNumber) + doc.split('\n')[lineNumber - 1]!.length

      const indented = run(indent, doc, caret)
      // Refused: no sibling above to nest under. Nothing to compose.
      if (indented === null || indented === doc) return

      // No exclusion: this property used to skip the shape where the
      // nearest shallower line above is not the one indent nested under
      // (hand-typed ragged indentation, depths 4, 6, 4), because outdent
      // landed on that line instead of on the parent. Outdent asks the
      // same question indent does now, so the statement holds over every
      // shape the generator draws and nothing is carved out of it.

      // The caret rides the line, which grew by the indent it gained.
      const grew =
        indented.split('\n')[lineNumber - 1]!.length - doc.split('\n')[lineNumber - 1]!.length
      const back = run(outdent, indented, caret + grew)
      expect(back).toBe(doc)
    },
  )
})

/**
 * Any command that rewrites a prefix also CANONICALISES it: `renderPrefix`
 * emits `- ` for every bullet and `N. ` for every ordered item, whatever
 * the author typed.
 *
 * Nothing covered this — no test in `line-prefix.test.ts` uses a `*` or `+`
 * bullet at all — and it is user-visible: a note authored with `*` bullets
 * is silently respelled the moment someone presses Tab on it. Found by a
 * round-trip property failing on `* alpha`, which looked like an indent bug
 * and was not.
 */
describe('a prefix rewrite canonicalises the marker', () => {
  it('respells a star bullet as a dash when the line is indented', () => {
    const doc = '- parent\n* child'
    expect(run(indent, doc, doc.length)).toBe('- parent\n  - child')
  })

  it('leaves a dash bullet alone, so the rewrite is the only difference', () => {
    const doc = '- parent\n- child'
    expect(run(indent, doc, doc.length)).toBe('- parent\n  - child')
  })
})

/**
 * The claim `nestingIndent`'s doc comment makes, asserted directly: a child
 * starts at its parent's CONTENT column, so the width is the sibling's
 * marker — `1. ` is three wide where `- ` is two — and not a fixed unit.
 *
 * The round-trip property above cannot see this: outdent returns to the
 * nearest shallower line whatever the width was, so replacing
 * `markerWidth(above)` with `INDENT_UNIT` leaves it green. Measured.
 */
describe('a nested line starts at its parent content column', () => {
  it('three under an ordered parent, because `1. ` is three wide', () => {
    const doc = '1. parent\n- child'
    expect(run(indent, doc, doc.length)).toBe('1. parent\n   - child')
  })

  it('two under a bullet parent, because `- ` is two wide', () => {
    const doc = '- parent\n- child'
    expect(run(indent, doc, doc.length)).toBe('- parent\n  - child')
  })
})
