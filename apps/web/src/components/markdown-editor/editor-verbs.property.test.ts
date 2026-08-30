/**
 * The markdown editor's verbs, as document transforms.
 *
 * Every verb in `MARKDOWN_EDITOR_VERBS` is a function from (document,
 * selection) to a new document, and each one has an algebraic invariant
 * worth stating rather than sampling: wrapping never loses text, a heading
 * level is idempotent and reversible, a task checkbox toggles back. Those
 * are what this file asserts.
 *
 * `VERB_COVERAGE` is why the file stays honest as the editor grows. It
 * rides on the `MarkdownVerbId` union, so a new verb fails the BUILD until
 * someone classifies it — the same mechanism the spatial editor's three
 * ledgers use, and the reason both now share one helper. See
 * `.claude/rules/coverage-ledger.md`.
 *
 * A ledger tally counts ATTEMPTS — that this run drove the verb at all.
 * Whether driving it CHANGED anything is a separate counter (`effects`),
 * asserted separately, because a generator too sparse to produce a task
 * line would leave `toggle-task` tallied and yet assert nothing. That
 * distinction is not hypothetical: it is what the canvas model's `reorders`
 * counter got wrong, passing on 16 attempts and 2 actual effects.
 */
import { EditorSelection, EditorState, type StateCommand } from '@codemirror/state'
import { afterAll, describe, expect } from 'vitest'
import { assertLedger, emptyTally, type SurfaceCoverage } from '../../test-utils/coverage-ledger.js'
import { fc, fcTest, withDefaults } from '../../test-utils/fast-check.js'
import {
  levelCommand,
  MARKDOWN_EDITOR_VERBS,
  type MarkdownVerbId,
  type MarkdownVerbSpec,
  selfContainedCommand,
  verb,
} from './editor-verbs.js'

/**
 * Every verb the editor can perform on the document.
 *
 * `link` is covered by its DOCUMENT half — the `[[ ]]` wrap it degrades to
 * when there is nothing to pick. Its picker dialog is a component rather
 * than a transform and is covered by `link-picker.browser.test.tsx`; a
 * property over text cannot reach it and should not pretend to.
 */
const VERB_COVERAGE = {
  heading: 'covered',
  bold: 'covered',
  italic: 'covered',
  code: 'covered',
  link: 'covered',
  'toggle-task': 'covered',
} satisfies Record<MarkdownVerbId, SurfaceCoverage>

const drives = emptyTally(VERB_COVERAGE)
/** How often driving a verb actually changed the document. Guards against a sparse generator. */
const effects = emptyTally(VERB_COVERAGE)

interface Applied {
  readonly doc: string
  readonly handled: boolean
}

/** Applies a verb's command at `anchor`..`head`, tallying the drive and any effect. */
function drive(
  id: MarkdownVerbId,
  command: StateCommand,
  doc: string,
  anchor: number,
  head = anchor,
): Applied {
  drives[id] += 1
  const state = EditorState.create({ doc, selection: EditorSelection.single(anchor, head) })
  let next = doc
  const handled = command({
    state,
    dispatch: (tr) => {
      next = tr.state.doc.toString()
    },
  })
  if (next !== doc) effects[id] += 1
  return { doc: next, handled }
}

/**
 * Lines chosen to make the interesting arrangements COMMON, not merely
 * reachable. A generator of arbitrary strings would produce a task item
 * about never, leaving `toggle-task` driven and asserting nothing — the
 * vacuity these properties exist to avoid.
 */
const line = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom('weekly review', 'ship the thing', 'notes and more') },
  { weight: 2, arbitrary: fc.constantFrom('# heading', '## deeper', '###### deepest') },
  {
    weight: 3,
    arbitrary: fc.constantFrom('- [ ] open task', '- [x] done task', '1. [ ] numbered'),
  },
  { weight: 1, arbitrary: fc.constant('') },
)

const document = fc.array(line, { minLength: 1, maxLength: 6 }).map((lines) => lines.join('\n'))

/** A document paired with a caret position inside it. */
const documentAndCaret = document.chain((doc) =>
  fc.record({ doc: fc.constant(doc), at: fc.integer({ min: 0, max: doc.length }) }),
)

/** The verbs that reduce to one command with no further input — everything but `heading`. */
const selfContained: readonly MarkdownVerbSpec[] = MARKDOWN_EDITOR_VERBS.filter(
  (spec) => selfContainedCommand(spec) !== null,
)

/**
 * The offset of line `index` (clamped), which is how a caret has to be
 * addressed ACROSS an edit. An offset is not a caret once the text under it
 * moves: a demote shortens the line by one, so re-using the same number
 * silently walks the caret onto the next line. That is not hypothetical —
 * it is what H1's first counterexample turned out to be.
 */
function lineStart(doc: string, index: number): number {
  const lines = doc.split('\n')
  const clamped = Math.min(index, lines.length - 1)
  let pos = 0
  for (let n = 0; n < clamped; n++) pos += lines[n].length + 1
  return pos
}

function countLines(doc: string): number {
  return doc.split('\n').length
}

/** Whether `inner` appears in `outer` in order, as a subsequence. */
function isSubsequence(inner: string, outer: string): boolean {
  let i = 0
  for (const ch of outer) if (i < inner.length && ch === inner[i]) i += 1
  return i === inner.length
}

describe('markdown editor verbs', () => {
  /**
   * V1, over the WHOLE table. Every verb edits within lines — delimiters
   * carry no newline, a heading marker is a line prefix, a checkbox is one
   * character — so none may add or remove a line. This is what drives every
   * verb at least once, which is what the ledger tallies.
   */
  fcTest.prop(
    [documentAndCaret, fc.integer({ min: 0, max: selfContained.length - 1 })],
    withDefaults(),
  )('V1: no verb changes the line count', ({ doc, at }, which) => {
    const spec = selfContained[which]
    const command = selfContainedCommand(spec)
    if (command === null) throw new Error(`${spec.id} lost its command`)
    const result = drive(spec.id, command, doc, at)
    expect(countLines(result.doc)).toBe(countLines(doc))
  })

  /**
   * W1. A wrap is insert-only by design (see `wrapSelectionWith` — unwrapping
   * is deliberately not attempted), so the document it started from must
   * survive inside the result, in order and complete.
   */
  fcTest.prop([documentAndCaret], withDefaults())(
    'W1: wrapping never loses a character of the document',
    ({ doc, at }) => {
      for (const id of ['bold', 'italic', 'code', 'link'] as const) {
        const spec = verb(id)
        const command = selfContainedCommand(spec)
        if (command === null) throw new Error(`${id} lost its command`)
        const result = drive(id, command, doc, at)
        expect(
          isSubsequence(doc, result.doc),
          `${id} dropped text from ${JSON.stringify(doc)}`,
        ).toBe(true)
        expect(result.doc.length).toBeGreaterThan(doc.length)
      }
    },
  )

  /**
   * H1. `setHeadingLevel` reports unhandled when nothing would change, so a
   * second application at the same level must be a no-op — a menu item that
   * silently re-writes the same text would put a junk entry in the undo
   * history on every click.
   */
  fcTest.prop(
    [document, fc.integer({ min: 0, max: 5 }), fc.integer({ min: 0, max: 3 })],
    withDefaults(),
  )(
    'H1: setting a heading level twice changes nothing the second time',
    (doc, lineIndex, level) => {
      // Addressed by LINE, not by offset — see `lineStart`. V1 pins that the
      // line count survives, so the same index still names the same line.
      const once = drive('heading', levelCommand(level), doc, lineStart(doc, lineIndex))
      const twice = drive('heading', levelCommand(level), once.doc, lineStart(once.doc, lineIndex))
      expect(twice.handled).toBe(false)
      expect(twice.doc).toBe(once.doc)
    },
  )

  /**
   * H2. Promote then demote returns the original, for a line that had no
   * heading marker to begin with. Restricted to single-line documents so the
   * caret cannot cover a line that already had one — that line's marker is
   * genuinely lost by the demote, which is what demote means.
   */
  fcTest.prop(
    [
      fc.constantFrom('weekly review', 'ship the thing', '- [ ] open task', 'notes and more'),
      fc.integer({ min: 1, max: 3 }),
    ],
    withDefaults(),
  )('H2: promoting a body line to a heading and back returns it unchanged', (body, level) => {
    const promoted = drive('heading', levelCommand(level), body, 0)
    expect(promoted.doc).not.toBe(body)
    const demoted = drive('heading', levelCommand(0), promoted.doc, 0)
    expect(demoted.doc).toBe(body)
  })

  /**
   * T1. Toggling a checkbox is an involution: twice returns the original.
   * Anchored on documents whose covered line IS a task item, since the
   * command reports unhandled — correctly — when none is.
   */
  fcTest.prop(
    [fc.constantFrom('- [ ] open task', '- [x] done task', '1. [ ] numbered')],
    withDefaults(),
  )('T1: toggling a task checkbox twice returns the original line', (taskLine) => {
    const command = selfContainedCommand(verb('toggle-task'))
    if (command === null) throw new Error('toggle-task lost its command')
    const once = drive('toggle-task', command, taskLine, 0)
    expect(once.handled).toBe(true)
    expect(once.doc).not.toBe(taskLine)
    const twice = drive('toggle-task', command, once.doc, 0)
    expect(twice.doc).toBe(taskLine)
  })

  afterAll(() => {
    assertLedger('editing verb', VERB_COVERAGE, drives)

    // The vacuity guard: being DRIVEN is not being exercised. A verb the
    // run never made change anything has asserted nothing about its own
    // behaviour, however green the properties above look.
    for (const id of Object.keys(VERB_COVERAGE) as MarkdownVerbId[]) {
      expect(
        effects[id],
        `editing verb "${id}" was driven ${drives[id]} times and never changed the document — the generator cannot reach the arrangement it acts on, so its properties are vacuous. Make the generator denser, do not lower the bar`,
      ).toBeGreaterThan(0)
    }
  })
})
