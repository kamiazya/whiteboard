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
import { normalizeMdast, parseMarkdownBody } from '@kamiazya/whiteboard-codec'
import { afterAll, describe, expect, it } from 'vitest'
import { assertLedger, emptyTally, type SurfaceCoverage } from '../../test-utils/coverage-ledger.js'
import { fc, fcTest, withDefaults } from '../../test-utils/fast-check.js'
import {
  cycleHeadingLevel,
  levelCommand,
  MARKDOWN_EDITOR_VERBS,
  type MarkdownVerbId,
  type MarkdownVerbSpec,
  selfContainedCommand,
  TOUCH_BAR_ORDER,
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
  'bullet-list': 'covered',
  'ordered-list': 'covered',
  outdent: 'covered',
  indent: 'covered',
  quote: 'covered',
  'code-block': 'covered',
  table: 'covered',
  rule: 'covered',
  strikethrough: 'covered',
  math: 'covered',
} satisfies Record<MarkdownVerbId, SurfaceCoverage>

/**
 * The verbs whose whole point is to ADD lines — a fence needs its own two,
 * a table its header and separator, a rule its own line. V1 is about every
 * other verb staying on the lines it was given; these are excluded by
 * name so a new line-inserting verb has to be listed here deliberately.
 */
const LINE_INSERTERS: ReadonlySet<MarkdownVerbId> = new Set(['code-block', 'table', 'rule'])

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
  // Indented lines, so outdent has something to take off.
  { weight: 1, arbitrary: fc.constantFrom('  - nested item', '  indented prose') },
  { weight: 1, arbitrary: fc.constant('') },
)

const document = fc.array(line, { minLength: 1, maxLength: 6 }).map((lines) => lines.join('\n'))

/**
 * Lines separated by blank lines and never two list items in a row, so every
 * line is a block of its own and a line end is a block end. Two adjacent
 * text lines are ONE paragraph and two list items ONE (loose) list even
 * across blank lines; a block tapped in between splits either — which is
 * what was asked for, but not what B3 is about.
 */
const isListLine = (text: string) => /^(-|\d+\.) /.test(text)
const blockDocument = fc
  // An indented line after a list item is that item's continuation, so
  // only lines starting at the margin are blocks of their own.
  .array(
    line.filter((text) => !text.startsWith(' ')),
    { minLength: 1, maxLength: 4 },
  )
  .filter((lines) => {
    // Blank lines do not end a list, so adjacency is judged over the
    // non-blank lines: `- a`, blank, blank, `- b` is still one list.
    const items = lines.filter((text) => text !== '')
    return items.every((text, i) => i === 0 || !(isListLine(text) && isListLine(items[i - 1])))
  })
  .map((lines) => lines.join('\n\n'))

/** A document paired with a caret position inside it. */
const documentAndCaret = document.chain((doc) =>
  fc.record({ doc: fc.constant(doc), at: fc.integer({ min: 0, max: doc.length }) }),
)

/** The verbs that reduce to one command with no further input — everything but `heading`. */
const selfContained: readonly MarkdownVerbSpec[] = MARKDOWN_EDITOR_VERBS.filter(
  (spec) => selfContainedCommand(spec) !== null,
)
const keepsLineCount: readonly MarkdownVerbSpec[] = selfContained.filter(
  (spec) => !LINE_INSERTERS.has(spec.id),
)

/** Lines carrying none of the list/quote prefixes, so a toggle's second application is exactly its inverse. */
const plainLine = fc.constantFrom('weekly review', 'ship the thing', 'notes and more', '')
const plainDocument = fc
  .array(plainLine, { minLength: 1, maxLength: 4 })
  .filter((lines) => lines.some((l) => l !== ''))
  .map((lines) => lines.join('\n'))

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

/**
 * The top-level blocks of `doc` as the parser reads them: kind and the text
 * under each, with the parser's own reading of headings kept separate from
 * paragraphs so a setext promotion shows up as a changed kind.
 */
function blocksOf(doc: string): { readonly type: string; readonly text: string }[] {
  const textUnder = (node: { type: string; value?: string; children?: unknown[] }): string =>
    (node.value ?? '') +
    (node.children ?? []).map((child) => textUnder(child as typeof node)).join('')
  return normalizeMdast(parseMarkdownBody(doc)).children.map((block) => ({
    type: block.type,
    text: textUnder(block),
  }))
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
    [documentAndCaret, fc.integer({ min: 0, max: keepsLineCount.length - 1 })],
    withDefaults(),
  )('V1: no verb but the declared line inserters changes the line count', ({ doc, at }, which) => {
    const spec = keepsLineCount[which]
    const command = selfContainedCommand(spec)
    if (command === null) throw new Error(`${spec.id} lost its command`)
    const result = drive(spec.id, command, doc, at)
    expect(countLines(result.doc)).toBe(countLines(doc))
  })

  /**
   * W1. On a word carrying none of the marks, a wrap adds its pair and
   * nothing else: the document it started from survives inside the result,
   * in order and complete. (The toggle's other half — the pair coming off
   * again — is the model test's, where the nest around the word is state.)
   */
  fcTest.prop([documentAndCaret], withDefaults())(
    'W1: wrapping never loses a character of the document',
    ({ doc, at }) => {
      for (const id of ['bold', 'italic', 'code', 'link', 'strikethrough', 'math'] as const) {
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
   * genuinely lost by the demote, which is what demote means. A task line is
   * not in the set either: a heading displaces its checkbox by design (GFM
   * reads `[ ] # x` as text), so `- [ ] x` round-trips to `- x`.
   */
  fcTest.prop(
    [
      fc.constantFrom('weekly review', 'ship the thing', '- open item', 'notes and more'),
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
    [fc.constantFrom('- [ ] open task', '- [x] done task', '1. [ ] numbered', 'plain prose')],
    withDefaults(),
  )('T1: the task button cycles a line back to itself in three presses', (line) => {
    const command = selfContainedCommand(verb('toggle-task'))
    if (command === null) throw new Error('toggle-task lost its command')
    let doc: string = line
    for (let step = 0; step < 3; step++) {
      const result = drive('toggle-task', command, doc, 0)
      expect(result.handled).toBe(true)
      expect(result.doc).not.toBe(doc)
      doc = result.doc
    }
    // A plain line joins the cycle as a bullet task, so it comes back as a bullet.
    expect(doc).toBe(line === 'plain prose' ? '- plain prose' : line)
  })

  fcTest.prop([plainDocument], withDefaults())(
    'L1: a list or quote prefix toggled twice over the whole document returns the original',
    (doc) => {
      for (const id of ['bullet-list', 'ordered-list', 'quote'] as const) {
        const command = selfContainedCommand(verb(id))
        if (command === null) throw new Error(`${id} lost its command`)
        const once = drive(id, command, doc, 0, doc.length)
        expect(once.handled, `${id} did nothing to ${JSON.stringify(doc)}`).toBe(true)
        expect(once.doc).not.toBe(doc)
        const twice = drive(id, command, once.doc, 0, once.doc.length)
        expect(twice.doc).toBe(doc)
      }
    },
  )

  /**
   * N1. Indent and outdent are the two verbs whose effect depends on the
   * lines ABOVE, so V1's random caret reaches them only by luck — it drove
   * `outdent` ten times without once landing on an indented line, and the
   * ledger's vacuity guard caught exactly that. This drives both on a
   * document where each must act: a second item always has a sibling above
   * to nest under, and a nested item is always liftable.
   */
  fcTest.prop(
    [
      fc.constantFrom('-', '1.'),
      fc.constantFrom('-', '1.'),
      fc.constantFrom('milk', 'tea', 'bread'),
    ],
    withDefaults(),
  )('N1: nesting the second item and lifting it back returns the document', (above, item, text) => {
    const doc = `${above} first\n${item} ${text}`
    const indent = selfContainedCommand(verb('indent'))
    const outdent = selfContainedCommand(verb('outdent'))
    if (indent === null || outdent === null) throw new Error('the indent band lost a command')
    // Caret at the end, where typing leaves it — and re-derived after the
    // edit, since the indent moved every offset on that line.
    const nested = drive('indent', indent, doc, doc.length)
    expect(nested.handled, `nothing to nest under in ${JSON.stringify(doc)}`).toBe(true)
    expect(nested.doc).not.toBe(doc)
    const lifted = drive('outdent', outdent, nested.doc, nested.doc.length)
    expect(lifted.handled).toBe(true)
    expect(lifted.doc).toBe(doc)
  })

  it('L2: a line already carrying the prefix is stripped, not doubled', () => {
    const cases = [
      ['bullet-list', '- item'],
      ['ordered-list', '1. item'],
      ['quote', '> item'],
    ] as const
    for (const [id, line] of cases) {
      const command = selfContainedCommand(verb(id))
      if (command === null) throw new Error(`${id} lost its command`)
      expect(drive(id, command, line, 0).doc).toBe('item')
    }
  })

  fcTest.prop([documentAndCaret], withDefaults())(
    'B1: a block inserter never loses a character and always adds lines',
    ({ doc, at }) => {
      for (const id of ['code-block', 'table', 'rule'] as const) {
        const command = selfContainedCommand(verb(id))
        if (command === null) throw new Error(`${id} lost its command`)
        const result = drive(id, command, doc, at)
        expect(isSubsequence(doc, result.doc), `${id} dropped text`).toBe(true)
        expect(countLines(result.doc)).toBeGreaterThan(countLines(doc))
      }
    },
  )

  it('B2: a code block around a selection fences the selected lines', () => {
    const command = selfContainedCommand(verb('code-block'))
    if (command === null) throw new Error('code-block lost its command')
    expect(drive('code-block', command, 'alpha\nbeta', 0, 10).doc).toBe('```\nalpha\nbeta\n```')
  })

  /**
   * B3, judged on the parse rather than the string. A block inserter tapped
   * at the end of a line adds exactly its block after that line's, and
   * leaves every other block as the parser read it before: same kinds in
   * the same order, same text. That is what rules out the spellings that
   * look right and parse wrong — `milk` + `---` is a setext heading, and
   * `milk```` is a paragraph ending in three backticks.
   */
  fcTest.prop([blockDocument, fc.nat()], withDefaults())(
    'B3: an inserter at a line end adds its block and changes no other block',
    (doc, lineChoice) => {
      const lineIndex = lineChoice % countLines(doc)
      const at = lineStart(doc, lineIndex) + doc.split('\n')[lineIndex].length
      const before = blocksOf(doc)
      for (const [id, type] of [
        ['rule', 'thematicBreak'],
        ['code-block', 'code'],
        ['table', 'table'],
      ] as const) {
        const command = selfContainedCommand(verb(id))
        if (command === null) throw new Error(`${id} lost its command`)
        const after = blocksOf(drive(id, command, doc, at).doc)
        const added = after.findIndex(
          (block, index) => block.type === type && before[index]?.type !== type,
        )
        expect(added, `${id} added no ${type} to ${JSON.stringify(doc)}`).toBeGreaterThanOrEqual(0)
        expect([...after.slice(0, added), ...after.slice(added + 1)]).toEqual(before)
      }
    },
  )

  fcTest.prop(
    [fc.constantFrom('weekly review', 'ship the thing', 'notes and more')],
    withDefaults(),
  )('H3: cycling the heading level has period four on a body line', (body) => {
    let doc: string = body
    for (let step = 0; step < 4; step++) {
      const result = drive('heading', cycleHeadingLevel, doc, 0)
      expect(result.handled).toBe(true)
      doc = result.doc
    }
    expect(doc).toBe(body)
  })

  it('the touch bar order places every verb exactly once', () => {
    const ids = MARKDOWN_EDITOR_VERBS.map((spec) => spec.id)
    expect([...TOUCH_BAR_ORDER].sort()).toEqual([...ids].sort())
    expect(new Set(TOUCH_BAR_ORDER).size).toBe(TOUCH_BAR_ORDER.length)
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
