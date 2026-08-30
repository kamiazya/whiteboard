import { EditorSelection, type StateCommand } from '@codemirror/state'
import { setHeadingLevel } from './set-heading-level.js'
import { toggleTaskCheckbox } from './toggle-task-checkbox.js'
import { rangeToActOn } from './word-at.js'

/**
 * Wraps what the caret is ON in `open`/`close` (Mod-b -> **, Mod-i -> *,
 * the catalog's [[ ]] passing two different delimiters). With a selection
 * that is the selection; without one it is the WORD under the caret, which
 * is what lets every verb work on a phone, where making a selection is the
 * hard part. A caret on whitespace has no word: that inserts an empty pair
 * and parks the cursor between the delimiters so the next keystroke lands
 * inside. Toggling (detecting an already-wrapped range and unwrapping) is
 * deliberately not attempted: markdown emphasis nesting makes reliable
 * detection lexer work, and a wrong unwrap corrupts text — insert-only is
 * predictable.
 */
export function wrapSelectionWith(open: string, close: string = open): StateCommand {
  return ({ state, dispatch }) => {
    const scope = rangeToActOn(state)
    dispatch(
      state.update({
        changes: [
          { from: scope.from, insert: open },
          { from: scope.to, insert: close },
        ],
        selection: EditorSelection.range(scope.from + open.length, scope.to + open.length),
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

export type MarkdownVerbId = 'heading' | 'bold' | 'italic' | 'code' | 'link' | 'toggle-task'

/**
 * Which run of the catalog a verb belongs to. The catalog draws a separator
 * where the band changes, so band membership is the verb's own property and
 * the separators are derived — a list of literal separator positions goes
 * stale the moment a verb is inserted.
 */
export type MarkdownVerbBand = 'block' | 'inline' | 'task'

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
  { id: 'bold', label: 'Bold', band: 'inline', key: 'Mod-b', action: { kind: 'wrap', open: '**' } },
  {
    id: 'italic',
    label: 'Italic',
    band: 'inline',
    key: 'Mod-i',
    action: { kind: 'wrap', open: '*' },
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
  {
    id: 'toggle-task',
    label: 'Toggle task',
    band: 'task',
    key: 'Mod-Enter',
    action: { kind: 'command', command: toggleTaskCheckbox },
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
