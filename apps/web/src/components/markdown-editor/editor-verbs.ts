import { EditorSelection, type StateCommand } from '@codemirror/state'
import { insertCodeBlock, insertRule, insertTable } from './block-inserts.js'
import {
  cycleTaskCheckbox,
  headingLevelAt,
  setHeadingLevel,
  setListMarker,
  toggleBlockquote,
} from './line-prefix.js'
import { rangeToActOn } from './word-at.js'

/**
 * Every delimiter pair an inline verb writes, longest opener first so the
 * nest around a word tokenises greedily: `***` reads as `**` then `*`.
 * Derived from the table below at call time, so a new inline verb is
 * recognised in a nest the moment it is declared.
 */
function inlineDelimiters(): readonly (readonly [open: string, close: string])[] {
  return MARKDOWN_EDITOR_VERBS.flatMap((spec): (readonly [string, string])[] => {
    const action = spec.action
    if (action.kind === 'wrap') return [[action.open, action.close ?? action.open]]
    if (action.kind === 'interactive') return [[action.fallback.open, action.fallback.close]]
    return []
  }).sort((a, b) => b[0].length - a[0].length)
}

interface NestedDelimiter {
  readonly open: string
  readonly close: string
  /** Where its opener sits, in document offsets. */
  readonly openFrom: number
  /** Where its closer sits, in document offsets. */
  readonly closeFrom: number
}

/**
 * The delimiters nested around `scope`, innermost first: matched pairs read
 * outward from the range on both sides at once, stopping at the first
 * character that is not the closer the opener before the range promised.
 * Reading both sides together is what keeps `**a** word` from looking like
 * a bold `word`.
 */
function nestAround(
  state: { readonly doc: { sliceString(from: number, to: number): string } },
  scope: { readonly from: number; readonly to: number },
  lineFrom: number,
  lineTo: number,
): NestedDelimiter[] {
  const before = state.doc.sliceString(lineFrom, scope.from)
  const after = state.doc.sliceString(scope.to, lineTo)
  const delimiters = inlineDelimiters()
  const nest: NestedDelimiter[] = []
  let consumedBefore = 0
  let consumedAfter = 0
  for (;;) {
    const beforeRest = before.slice(0, before.length - consumedBefore)
    const afterRest = after.slice(consumedAfter)
    const pair = delimiters.find(
      ([open, close]) => beforeRest.endsWith(open) && afterRest.startsWith(close),
    )
    if (pair === undefined) return nest
    const [open, close] = pair
    consumedBefore += open.length
    nest.push({
      open,
      close,
      openFrom: scope.from - consumedBefore,
      closeFrom: scope.to + consumedAfter,
    })
    consumedAfter += close.length
  }
}

/**
 * Toggles `open`/`close` around what the caret is ON (Mod-b -> **, Mod-i -> *,
 * the catalog's [[ ]] passing two different delimiters). With a selection
 * that is the selection; without one it is the WORD under the caret, which
 * is what lets every verb work on a phone, where making a selection is the
 * hard part. A caret on whitespace has no word: that inserts an empty pair
 * and parks the cursor between the delimiters so the next keystroke lands
 * inside.
 *
 * A mark is a toggle on the word, not a wrapper: when this verb's own pair
 * already sits anywhere in the nest around the range — `**~~word~~**` is
 * bold, however the strikethrough got inside it — the press removes that
 * pair and only that pair, so a second press always undoes the first, which
 * is what a B button means everywhere else. The nest is read at the text
 * level as matched pairs (see `nestAround`), never by a lexer: what the
 * parser makes of `**` inside a code span is its business, and the button
 * still takes the bold off. A selection that itself begins and ends with
 * the pair is stripped the same way. Anything else wraps.
 */
export function wrapSelectionWith(open: string, close: string = open): StateCommand {
  return ({ state, dispatch }) => {
    const main = state.selection.main
    const scope = rangeToActOn(state)
    // A selection stays a selection on the same text; a caret stays a caret
    // on the same character. Selecting the word a caret was merely ON would
    // make the next keystroke REPLACE it — on a phone, where the bar is
    // tapped mid-typing, that reads as the word vanishing.
    const shifted = (by: number) =>
      main.empty
        ? EditorSelection.cursor(main.head + by)
        : EditorSelection.range(scope.from + by, scope.to + by)
    const line = state.doc.lineAt(scope.from)
    const own = nestAround(state, scope, line.from, state.doc.lineAt(scope.to).to).find(
      (pair) => pair.open === open && pair.close === close,
    )
    if (own !== undefined) {
      dispatch(
        state.update({
          changes: [
            { from: own.openFrom, to: own.openFrom + open.length },
            { from: own.closeFrom, to: own.closeFrom + close.length },
          ],
          selection: shifted(-open.length),
          scrollIntoView: true,
          userEvent: 'delete',
        }),
      )
      return true
    }
    const selected = state.doc.sliceString(scope.from, scope.to)
    if (
      selected.length >= open.length + close.length &&
      selected.startsWith(open) &&
      selected.endsWith(close)
    ) {
      dispatch(
        state.update({
          changes: [
            { from: scope.from, to: scope.from + open.length },
            { from: scope.to - close.length, to: scope.to },
          ],
          selection: EditorSelection.range(scope.from, scope.to - open.length - close.length),
          scrollIntoView: true,
          userEvent: 'delete',
        }),
      )
      return true
    }
    dispatch(
      state.update({
        changes: [
          { from: scope.from, insert: open },
          { from: scope.to, insert: close },
        ],
        selection: shifted(open.length),
        scrollIntoView: true,
        userEvent: 'input',
      }),
    )
    return true
  }
}

/**
 * How a verb changes the document.
 *
 * The split is by what the verb NEEDS, not by what it looks like in a
 * menu: everything but `interactive` is a pure document transform that a
 * test can drive against an `EditorState` with no React and no browser,
 * which is what makes the property test one layer down possible at all.
 */
export type MarkdownVerbAction =
  /** Inserts delimiters around the caret's scope. */
  | { readonly kind: 'wrap'; readonly open: string; readonly close?: string }
  /** Runs a command over the line(s) the selection covers. */
  | { readonly kind: 'command'; readonly command: StateCommand }
  /** A band of mutually exclusive levels, rendered as one options row. */
  | {
      readonly kind: 'levels'
      readonly levels: readonly { readonly label: string; readonly level: number }[]
    }
  /**
   * Asks the user something before it writes, so the editor — not this
   * table — owns the surface. It declares the wrap it DEGRADES to when
   * there is nothing to ask about, which is the half a test can reach.
   */
  | {
      readonly kind: 'interactive'
      readonly fallback: { readonly open: string; readonly close: string }
    }

export type MarkdownVerbId =
  | 'heading'
  | 'quote'
  | 'code-block'
  | 'table'
  | 'rule'
  | 'bold'
  | 'italic'
  | 'strikethrough'
  | 'code'
  | 'link'
  | 'math'
  | 'bullet-list'
  | 'ordered-list'
  | 'toggle-task'

/**
 * Which run of the catalog a verb belongs to. The catalog draws a separator
 * where the band changes, so band membership is the verb's own property and
 * the separators are derived — a list of literal separator positions goes
 * stale the moment a verb is inserted.
 */
export type MarkdownVerbBand = 'block' | 'inline' | 'list'

export interface MarkdownVerbSpec {
  readonly id: MarkdownVerbId
  readonly label: string
  readonly band: MarkdownVerbBand
  /**
   * The key that runs it inside the source pane, in CodeMirror's notation.
   * Absent means the verb is reachable only from the catalog — which is a
   * decision, not an oversight: `heading` is a band of four and `link` opens
   * a picker, and neither survives being flattened onto one chord.
   */
  readonly key?: string
  readonly action: MarkdownVerbAction
}

/**
 * Every verb the markdown editor can perform on the document, declared once.
 *
 * Two surfaces read this table — the source pane's keymap and the editing
 * catalog — and before it existed they were two hand-maintained lists with
 * the delimiters written out twice. `Mod-b` and the catalog's Bold row each
 * carried their own `'**'`, so nothing but a reader stopped them drifting.
 *
 * Order is the catalog's reading order. The separators between bands are
 * the catalog's own concern, not a property of a verb.
 */
export const MARKDOWN_EDITOR_VERBS: readonly MarkdownVerbSpec[] = [
  {
    id: 'heading',
    label: 'Heading',
    band: 'block',
    action: {
      kind: 'levels',
      levels: [
        { label: 'Body', level: 0 },
        { label: 'H1', level: 1 },
        { label: 'H2', level: 2 },
        { label: 'H3', level: 3 },
      ],
    },
  },
  {
    id: 'quote',
    label: 'Quote',
    band: 'block',
    action: { kind: 'command', command: toggleBlockquote },
  },
  {
    id: 'code-block',
    label: 'Code block',
    band: 'block',
    action: { kind: 'command', command: insertCodeBlock },
  },
  { id: 'table', label: 'Table', band: 'block', action: { kind: 'command', command: insertTable } },
  { id: 'rule', label: 'Divider', band: 'block', action: { kind: 'command', command: insertRule } },
  { id: 'bold', label: 'Bold', band: 'inline', key: 'Mod-b', action: { kind: 'wrap', open: '**' } },
  {
    id: 'italic',
    label: 'Italic',
    band: 'inline',
    key: 'Mod-i',
    action: { kind: 'wrap', open: '*' },
  },
  {
    id: 'strikethrough',
    label: 'Strikethrough',
    band: 'inline',
    action: { kind: 'wrap', open: '~~' },
  },
  { id: 'code', label: 'Code', band: 'inline', key: 'Mod-e', action: { kind: 'wrap', open: '`' } },
  {
    // One verb for both kinds of link: the picker's search box decides
    // where it goes, so nothing asks the author to classify a destination
    // before typing it. With no targets to pick from there is nothing to
    // open, and the verb keeps its bracket wrap.
    id: 'link',
    label: 'Link',
    band: 'inline',
    action: { kind: 'interactive', fallback: { open: '[[', close: ']]' } },
  },
  { id: 'math', label: 'Math', band: 'inline', action: { kind: 'wrap', open: '$' } },
  {
    id: 'bullet-list',
    label: 'Bullet list',
    band: 'list',
    action: { kind: 'command', command: setListMarker('bullet') },
  },
  {
    id: 'ordered-list',
    label: 'Numbered list',
    band: 'list',
    action: { kind: 'command', command: setListMarker('ordered') },
  },
  {
    // One button walks none -> open -> done -> none (see line-prefix.ts), the
    // way the heading slot walks its levels; the same command is Mod-Enter.
    id: 'toggle-task',
    label: 'Task',
    band: 'list',
    key: 'Mod-Enter',
    action: { kind: 'command', command: cycleTaskCheckbox },
  },
]

/** The one verb of a given id. Throws rather than returning undefined: the id is a closed union. */
export function verb(id: MarkdownVerbId): MarkdownVerbSpec {
  const found = MARKDOWN_EDITOR_VERBS.find((spec) => spec.id === id)
  if (found === undefined) throw new Error(`no markdown verb "${id}"`)
  return found
}

/** The command a level within a `levels` action runs. */
export function levelCommand(level: number): StateCommand {
  return setHeadingLevel(level)
}

/**
 * One tap on the touch bar's heading slot: advance to the next level in the
 * heading verb's own band, wrapping from the last back to body text. Derived
 * from the same `levels` the catalog renders, so the two cannot disagree
 * about what "next" is; a level the band does not list (H4-H6) restarts at
 * the band's first entry.
 */
export const cycleHeadingLevel: StateCommand = ({ state, dispatch }) => {
  const action = verb('heading').action
  if (action.kind !== 'levels') return false
  const levels = action.levels.map((option) => option.level)
  const index = levels.indexOf(headingLevelAt(state))
  const next = levels[(index + 1) % levels.length]
  return setHeadingLevel(next)({ state, dispatch })
}

/**
 * The touch bar's priority order: what stays on screen first as the bar
 * narrows (`layoutTouchBar` takes a prefix of this). A permutation of every
 * verb id, pinned by the property test, so a new verb has to be given a
 * place here rather than silently never reaching the bar.
 */
export const TOUCH_BAR_ORDER: readonly MarkdownVerbId[] = [
  'heading',
  'bold',
  'italic',
  'code',
  'link',
  'bullet-list',
  'toggle-task',
  'ordered-list',
  'quote',
  'code-block',
  'table',
  'rule',
  'strikethrough',
  'math',
]

/**
 * The document transform a verb performs with no further input, or `null`
 * when it has none — `levels` needs a level chosen and `interactive` needs
 * the dialog's answer, so neither reduces to a single command.
 */
export function selfContainedCommand(spec: MarkdownVerbSpec): StateCommand | null {
  const action = spec.action
  switch (action.kind) {
    case 'wrap':
      return wrapSelectionWith(action.open, action.close)
    case 'command':
      return action.command
    case 'interactive':
      return wrapSelectionWith(action.fallback.open, action.fallback.close)
    case 'levels':
      return null
  }
}

/**
 * Shared with the spatial node editor (markdown-editor and spatial-editor
 * are sibling features of one app): the same wrap shortcuts everywhere a
 * markdown source is edited. Note Mod-Enter (task toggle) is deliberately
 * OUTRANKED by the node editor's commit binding — the overlay's exit verb
 * wins there; the document editor keeps the toggle.
 *
 * Derived from the table rather than written beside it, so a verb cannot
 * gain a key in one list and keep the old delimiters in the other.
 */
export const markdownStyleKeymap = MARKDOWN_EDITOR_VERBS.flatMap((spec) => {
  if (spec.key === undefined) return []
  const command = selfContainedCommand(spec)
  return command === null ? [] : [{ key: spec.key, run: command }]
})
