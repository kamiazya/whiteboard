// @vitest-environment node
/**
 * The markdown editor's verbs as ONE state machine over the caret's line,
 * checked by command sequences (fast-check model-based testing) and judged
 * on the parsed document rather than on its spelling.
 *
 * The MODEL is a line's intent: whether it is quoted, its list marker and
 * checkbox, its heading level, the marks on its word, and the word. Every
 * touch-bar press is a move in that space, and the transition table is
 * written out here by hand — so a press whose meaning was never decided
 * (a heading tap on a task, bold on a word already in a code span, a
 * divider under a paragraph) fails here instead of surprising a thumb.
 *
 * The REAL side is an `EditorState` carried across presses, selection
 * included, the way a phone session carries it. After every press the real
 * document is parsed with codec's own pipeline — the parser every surface
 * that renders this text goes through — and its mdast is compared with the
 * shape the model implies. Judging the TREE rather than the string is what
 * lets the test say "this is a task item" without pinning `-` over `*`, and
 * what catches the spellings that parse as something else entirely:
 * `- [ ] # milk` is not a heading, `milk` + `---` is a setext heading, and
 * `***milk***` has no press order for a string to remember.
 *
 * Decisions the table records, each one a semantic the buttons now carry:
 *   - quote wraps outermost; a list marker sits inside it; a heading sits
 *     inside the list item. That is the one nesting GFM reads back the same
 *     way, so it is the one the verbs write.
 *   - a heading and a checkbox exclude each other (GFM reads `[ ] # x` as
 *     text), so setting one clears the other rather than writing a marker
 *     the parser ignores.
 *   - an inline mark is a toggle on the word: pressing a mark that is
 *     already active removes it wherever it sits in the nest, so a second
 *     press always undoes the first. Marks inside a code or math span are
 *     literal text, which is what the parser makes of them.
 *   - every press on an empty line writes the marker to type into, so no
 *     button is ever a no-op.
 *   - the block inserters that take the caret INTO the new block (code
 *     block, table) are not part of this machine — what a verb means inside
 *     a table cell or a fence is undecided, and they are declared so below.
 *
 * What the parser cannot see is kept OUT of the oracle rather than faked:
 * `[[ ]]` is not markdown to codec, so a link mark is brackets in the text;
 * and `- [ ] ` with no text is a paragraph reading `[ ]`, the state the bar
 * leaves behind for the word about to be typed. The model expects exactly
 * that, so the run still checks the string the parser was given.
 */
import { EditorSelection, EditorState } from '@codemirror/state'
import { normalizeMdast, parseMarkdownBody } from '@kamiazya/whiteboard-codec'
import { afterAll, describe, expect } from 'vitest'
import { assertLedger, emptyTally, type SurfaceCoverage } from '../../test-utils/coverage-ledger.js'
import { fc, fcTest, withDefaults } from '../../test-utils/fast-check.js'
import {
  cycleHeadingLevel,
  type MarkdownVerbId,
  selfContainedCommand,
  verb,
} from './editor-verbs.js'

const VERB_COVERAGE = {
  heading: 'covered',
  quote: 'covered',
  rule: 'covered',
  bold: 'covered',
  italic: 'covered',
  strikethrough: 'covered',
  code: 'covered',
  link: 'covered',
  math: 'covered',
  'bullet-list': 'covered',
  'ordered-list': 'covered',
  'toggle-task': 'covered',
  outdent:
    'not modelled: its meaning comes from the lines above; list-nesting.model.property.test.ts',
  indent:
    'not modelled: its meaning comes from the lines above; list-nesting.model.property.test.ts',
  'code-block':
    'not modelled: takes the caret into the fence, where what a verb means is undecided; B1-B3 in editor-verbs.property.test.ts',
  table:
    'not modelled: takes the caret into a cell, where what a verb means is undecided; B1 and B3 in editor-verbs.property.test.ts',
} satisfies Record<MarkdownVerbId, SurfaceCoverage>

const drives = emptyTally(VERB_COVERAGE)

type Marker = 'none' | 'bullet' | 'ordered'
type Checkbox = 'none' | 'open' | 'done'
type Mark = 'bold' | 'italic' | 'strikethrough' | 'code' | 'link' | 'math'

/** The test's own spelling of each mark — never read from the code under test. */
const MARK_DELIMITERS: Record<Mark, readonly [open: string, close: string]> = {
  bold: ['**', '**'],
  italic: ['*', '*'],
  strikethrough: ['~~', '~~'],
  code: ['`', '`'],
  link: ['[[', ']]'],
  math: ['$', '$'],
}
/** The mdast node each mark becomes; `link` is text to codec (see references.ts). */
const MARK_NODE: Record<Mark, string | null> = {
  bold: 'strong',
  italic: 'emphasis',
  strikethrough: 'delete',
  code: 'inlineCode',
  math: 'inlineMath',
  link: null,
}
const INLINE_NODE_TYPES = new Set(['strong', 'emphasis', 'delete', 'inlineCode', 'inlineMath'])
/** Whatever sits inside one of these is literal text to the parser. */
const LITERAL_MARKS: ReadonlySet<Mark> = new Set(['code', 'math'])
const HEADING_CYCLE = [0, 1, 2, 3]

interface Line {
  quote: boolean
  marker: Marker
  /** What an ordered marker shows; a freshly made one shows 1. */
  number: number
  checkbox: Checkbox
  heading: number
  /** Outermost first. */
  marks: Mark[]
  readonly text: string
}

interface Model {
  /** Blocks a divider has closed off, in document order. */
  readonly finished: (Line | 'rule')[]
  line: Line
}

interface Real {
  state: EditorState
}

function freshLine(): Line {
  return {
    quote: false,
    marker: 'none',
    number: 1,
    checkbox: 'none',
    heading: 0,
    marks: [],
    text: '',
  }
}

function renderInline(marks: readonly Mark[], text: string): string {
  return marks.reduceRight((inner, mark) => {
    const [open, close] = MARK_DELIMITERS[mark]
    return `${open}${inner}${close}`
  }, text)
}

/** The model's own rendering of a line — the start state the real side is given. */
function renderLine(line: Line): string {
  const marker = line.marker === 'none' ? '' : line.marker === 'bullet' ? '- ' : `${line.number}. `
  const checkbox = line.checkbox === 'none' ? '' : line.checkbox === 'open' ? '[ ] ' : '[x] '
  const heading = line.heading === 0 ? '' : `${'#'.repeat(line.heading)} `
  return `${line.quote ? '> ' : ''}${marker}${checkbox}${heading}${renderInline(line.marks, line.text)}`
}

function rendersABlock(line: Line): boolean {
  return line.quote || line.marker !== 'none' || line.heading > 0 || line.text !== ''
}

// ---------------------------------------------------------------- the shape

/** What one top-level block looks like, read the same way from the tree and from the model. */
interface BlockShape {
  readonly quote: boolean
  readonly list: null | {
    readonly ordered: boolean
    readonly start: number | null
    readonly checked: boolean | null
  }
  readonly leaf: null | {
    readonly kind: string
    readonly depth: number
    /** Inline node types under the leaf, sorted and deduplicated. */
    readonly marks: readonly string[]
    /** Every text-ish value under the leaf, concatenated. */
    readonly plain: string
  }
}
type Shape = BlockShape | 'rule'

interface Node {
  readonly type: string
  readonly children?: readonly Node[]
  readonly value?: string
  readonly depth?: number
  readonly ordered?: boolean
  readonly start?: number | null
  readonly checked?: boolean | null
}

function onlyChild(node: Node): Node | undefined {
  const children = node.children ?? []
  if (children.length > 1) {
    return { type: `${children.length} children where the model has at most one` }
  }
  return children[0]
}

function inlineOf(leaf: Node): { marks: string[]; plain: string } {
  const marks = new Set<string>()
  let plain = ''
  const walk = (node: Node) => {
    if (INLINE_NODE_TYPES.has(node.type)) marks.add(node.type)
    if (node.value !== undefined) plain += node.value
    for (const child of node.children ?? []) walk(child)
  }
  for (const child of leaf.children ?? []) walk(child)
  return { marks: [...marks].sort(), plain }
}

function observeBlock(block: Node): Shape {
  if (block.type === 'thematicBreak') return 'rule'
  let node: Node | undefined = block
  const quote = node.type === 'blockquote'
  if (quote) node = onlyChild(node)
  let list: BlockShape['list'] = null
  if (node?.type === 'list') {
    const item = onlyChild(node)
    list = {
      ordered: node.ordered === true,
      start: node.ordered === true ? (node.start ?? 1) : null,
      checked: item?.checked ?? null,
    }
    node = item === undefined ? undefined : onlyChild(item)
  }
  const leaf =
    node === undefined ? null : { kind: node.type, depth: node.depth ?? 0, ...inlineOf(node) }
  return { quote, list, leaf }
}

function observe(doc: string): Shape[] {
  const root = normalizeMdast(parseMarkdownBody(doc)) as unknown as Node
  return (root.children ?? []).map(observeBlock)
}

/** The inline shape a nest of marks around `text` parses to. */
function expectedInline(marks: readonly Mark[], text: string): { marks: string[]; plain: string } {
  const seen = new Set<string>()
  let prefix = ''
  let suffix = ''
  for (const [index, mark] of marks.entries()) {
    const node = MARK_NODE[mark]
    if (node === null) {
      const [open, close] = MARK_DELIMITERS[mark]
      prefix += open
      suffix = close + suffix
      continue
    }
    seen.add(node)
    if (LITERAL_MARKS.has(mark)) {
      return {
        marks: [...seen].sort(),
        plain: prefix + renderInline(marks.slice(index + 1), text) + suffix,
      }
    }
  }
  return { marks: [...seen].sort(), plain: prefix + text + suffix }
}

function expectedBlock(line: Line): BlockShape {
  const typingAhead = line.text === '' && line.checkbox !== 'none'
  const list =
    line.marker === 'none'
      ? null
      : {
          ordered: line.marker === 'ordered',
          start: line.marker === 'ordered' ? line.number : null,
          // GFM only reads a checkbox that has a paragraph after it; until
          // the word is typed the item is unchecked and its text is the box.
          checked: typingAhead ? null : line.checkbox === 'none' ? null : line.checkbox === 'done',
        }
  const leaf = typingAhead
    ? {
        kind: 'paragraph',
        depth: 0,
        marks: [],
        plain: line.checkbox === 'open' ? '[ ]' : '[x]',
      }
    : line.heading > 0
      ? { kind: 'heading', depth: line.heading, ...expectedInline(line.marks, line.text) }
      : line.text === ''
        ? null
        : { kind: 'paragraph', depth: 0, ...expectedInline(line.marks, line.text) }
  return { quote: line.quote, list, leaf }
}

function expected(model: Model): Shape[] {
  const shapes: Shape[] = model.finished.map((block) =>
    block === 'rule' ? 'rule' : expectedBlock(block),
  )
  if (rendersABlock(model.line)) shapes.push(expectedBlock(model.line))
  return shapes
}

// ------------------------------------------------------------- the commands

function press(real: Real, id: MarkdownVerbId): void {
  drives[id] += 1
  const command = id === 'heading' ? cycleHeadingLevel : selfContainedCommand(verb(id))
  if (command === null) throw new Error(`${id} lost its command`)
  const handled = command({
    state: real.state,
    dispatch: (tr) => {
      real.state = tr.state
    },
  })
  expect(handled, `${id} reported nothing to do`).toBe(true)
}

function judge(model: Model, real: Real): void {
  expect(observe(real.state.doc.toString())).toEqual(expected(model))
}

abstract class Press implements fc.Command<Model, Real> {
  abstract readonly id: MarkdownVerbId
  check(_model: Readonly<Model>): boolean {
    return true
  }
  abstract move(line: Line, model: Model): void
  run(model: Model, real: Real): void {
    press(real, this.id)
    this.move(model.line, model)
    judge(model, real)
  }
  toString(): string {
    return this.id
  }
}

class Heading extends Press {
  readonly id = 'heading'
  move(line: Line): void {
    const next = HEADING_CYCLE[(HEADING_CYCLE.indexOf(line.heading) + 1) % HEADING_CYCLE.length]
    line.heading = next
    if (next > 0) line.checkbox = 'none'
  }
}

class Quote extends Press {
  readonly id = 'quote'
  move(line: Line): void {
    line.quote = !line.quote
  }
}

class ListMarker extends Press {
  constructor(readonly id: 'bullet-list' | 'ordered-list') {
    super()
  }
  move(line: Line): void {
    const kind: Marker = this.id === 'bullet-list' ? 'bullet' : 'ordered'
    if (line.marker === kind) {
      line.marker = 'none'
      line.checkbox = 'none'
    } else {
      line.marker = kind
      if (kind === 'ordered') line.number = 1
    }
  }
}

class Task extends Press {
  readonly id = 'toggle-task'
  move(line: Line): void {
    switch (line.checkbox) {
      case 'none':
        if (line.marker === 'none') line.marker = 'bullet'
        line.heading = 0
        line.checkbox = 'open'
        return
      case 'open':
        line.checkbox = 'done'
        return
      case 'done':
        line.checkbox = 'none'
    }
  }
}

class Inline extends Press {
  constructor(readonly id: Mark) {
    super()
  }
  /**
   * With no word under the caret a wrap parks an empty pair for the next
   * keystroke — a typing-ahead state whose parse (`****` is a divider) says
   * nothing about the editor. The word is what this machine is about.
   */
  override check(model: Readonly<Model>): boolean {
    return model.line.text !== ''
  }
  move(line: Line): void {
    const at = line.marks.indexOf(this.id)
    if (at >= 0) line.marks.splice(at, 1)
    else line.marks.push(this.id)
  }
}

class Rule extends Press {
  readonly id = 'rule'
  move(line: Line, model: Model): void {
    if (rendersABlock(line)) model.finished.push({ ...line, marks: [...line.marks] })
    model.finished.push('rule')
    model.line = freshLine()
  }
}

/**
 * Not a verb: the user typing the line's first word. The machine needs it
 * because `Rule` opens a fresh empty line and every mark's meaning starts at
 * a word — without typing, the first `rule` in a sequence closes the inline
 * verbs for the REST of it (`Inline.check` gates on a non-empty line, and
 * nothing else ever put text back). Measured before this command existed:
 * across five full executions the six marks were driven 0–13 times each
 * while every structure verb was driven ~400–480, and the ledger failure CI
 * saw — `code` marked covered but never produced — is that distribution's
 * tail. The word is inserted at the caret, so it lands inside whatever
 * structure the presses have built; `judge` holds it to the model like any
 * press.
 */
class Type implements fc.Command<Model, Real> {
  check(model: Readonly<Model>): boolean {
    return model.line.text === ''
  }
  run(model: Model, real: Real): void {
    const head = real.state.selection.main.head
    real.state = real.state.update({
      changes: { from: head, insert: 'milk' },
      selection: EditorSelection.cursor(head + 'milk'.length),
    }).state
    // `Line.text` is readonly because no VERB writes it, and typing is not a
    // verb — the line is replaced rather than the field assigned, so that
    // statement stays checked by the compiler.
    model.line = { ...model.line, text: 'milk' }
    judge(model, real)
  }
  toString(): string {
    return 'type'
  }
}

// ------------------------------------------------------------ the generator

const mark = fc.constantFrom<Mark>('bold', 'italic', 'strikethrough', 'code', 'link', 'math')

const initialLine: fc.Arbitrary<Line> = fc
  .record({
    quote: fc.boolean(),
    marker: fc.constantFrom<Marker>('none', 'bullet', 'ordered'),
    number: fc.integer({ min: 1, max: 9 }),
    checkbox: fc.constantFrom<Checkbox>('none', 'open', 'done'),
    heading: fc.integer({ min: 0, max: 6 }),
    marks: fc.uniqueArray(mark, { maxLength: 3 }),
    text: fc.constantFrom('', 'milk', 'weekly', '牛乳'),
  })
  .map((line) => ({
    ...line,
    // What is not a line is not a start state: a checkbox needs a marker
    // and excludes a heading; a mark needs a word.
    checkbox: line.marker === 'none' || line.heading > 0 ? ('none' as const) : line.checkbox,
    marks: line.text === '' ? [] : line.marks,
  }))

const presses = fc.commands(
  [
    fc.constant(new Heading()),
    fc.constant(new Quote()),
    fc.constant(new ListMarker('bullet-list')),
    fc.constant(new ListMarker('ordered-list')),
    fc.constant(new Task()),
    mark.map((id) => new Inline(id)),
    fc.constant(new Rule()),
    fc.constant(new Type()),
  ],
  { size: '+1' },
)

/**
 * Measured: 200 runs take 6.4s on an idle machine — about 32ms per run, each
 * a sequence of presses with a full remark parse after every one. Sixty
 * runs keep the property around 2s alone; the ceiling below is for the
 * parallel suite, where this file shares the machine with every other
 * project and a per-test default of 5s reads as a property failure
 * (`Test timed out` is the tell — see integrator-flow.md, CI flakes).
 */
const RUNS = 60
const CEILING_MS = 30_000

describe('markdown editor verbs as a state machine over the caret line', () => {
  fcTest.prop([initialLine, presses], withDefaults({ numRuns: RUNS }))(
    'after every press the parsed document is the shape the transition table implies',
    (initial, cmds) => {
      fc.modelRun(() => {
        const doc = renderLine(initial)
        const model: Model = { finished: [], line: { ...initial, marks: [...initial.marks] } }
        // The caret sits where typing left it: at the end of the word, inside
        // whatever marks the bar has already put around it.
        const closers = initial.marks.reduce((n, mark) => n + MARK_DELIMITERS[mark][1].length, 0)
        const real: Real = {
          state: EditorState.create({
            doc,
            selection: EditorSelection.cursor(doc.length - closers),
          }),
        }
        // The start state itself must read back as the model says, or every
        // later comparison is measuring the renderer above, not the verbs.
        judge(model, real)
        return { model, real }
      }, cmds)
    },
    CEILING_MS,
  )

  afterAll(() => {
    assertLedger('editing verb', VERB_COVERAGE, drives)
    // A FLOOR for the marks, not only the ledger's "at least once" — the
    // same guard-of-the-guard edge-rules.properties.test.ts carries, for the
    // same reason. Without `Type` in the pool the marks were driven 0–13
    // times per execution against ~400+ for every structure verb, and the
    // ledger failed only on the tail of that distribution: a red build
    // pointing at a file nobody had changed. With `Type`, measured over five
    // executions, every mark lands 18–46. The floor sits well below that
    // without pinning a distribution; a generator change that thins the
    // marks back out fails HERE, every run, naming the thin mark.
    const MARK_DRIVE_FLOOR = 8
    for (const id of ['bold', 'italic', 'strikethrough', 'code', 'link', 'math'] as const) {
      expect(
        drives[id],
        `mark "${id}" was driven ${drives[id]} time(s); the generator has gone sparse (see Type)`,
      ).toBeGreaterThanOrEqual(MARK_DRIVE_FLOOR)
    }
  })
})
