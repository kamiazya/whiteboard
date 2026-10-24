/**
 * The editor's keyboard shortcut catalog — the ONE place every binding is
 * declared (user decision 2026-08-09). A future help sheet or settings
 * surface reads this table; ad-hoc `e.key === …` checks in components are
 * the drift this file exists to prevent.
 *
 * Two kinds of entries:
 * - Table-dispatched: `handleKeyDown` matches the event against this table
 *   and routes to a handler keyed by `id` (all new shortcuts land here).
 * - `handledInline: true`: bindings that predate the table and still live
 *   as bespoke branches in `handleKeyDown` (their guards are deeply
 *   stateful). They are declared here so the catalog stays complete, and
 *   the matcher deliberately skips them.
 */
import type { EditorTool } from '../../lib/editor-tool.js'
export type ShortcutId =
  | 'toggle-lock'
  | 'zoom-in'
  | 'zoom-out'
  | 'zoom-to-fit'
  | 'zoom-to-selection'
  | 'select-all'
  | 'copy-selection'
  | 'cut-selection'
  | 'paste-clipboard'
  | 'duplicate-selection'
  | 'reorder-forward'
  | 'reorder-backward'
  | 'reorder-front'
  | 'reorder-back'
  | 'delete-selection'
  | 'commit-text-edit'
  | 'cancel'
  | 'space-pan'
  | 'nudge-selection'
  | 'show-shortcuts'
  | 'tool-select'
  | 'tool-hand'
  | 'tool-connect'
  | 'connect-pick-target'
  | 'tool-draw'
  | 'new-note'
  | 'select-next-node'
  | 'select-previous-node'
  | 'select-adjacent-node'
  | 'edit-selected-node'
  | 'open-context-menu'
  | 'open-context-menu-shift-f10'
  | 'comment-on-selection'
  | 'undo'
  | 'redo'

/** The headings the help sheet groups the catalog under, in display order. */
export const SHORTCUT_SECTIONS = [
  'Tools',
  'Navigate',
  'Edit',
  'Arrange',
  'View',
  'Text',
  'Help',
] as const
type ShortcutSection = (typeof SHORTCUT_SECTIONS)[number]

export interface ShortcutSpec {
  readonly id: ShortcutId
  /** The help sheet's group — required, so a new row must choose one. */
  readonly section: ShortcutSection
  /**
   * Physical-key match (`KeyboardEvent.code`) — used for punctuation keys
   * like the brackets, whose `key` value shifts with layout and modifiers.
   */
  readonly codes?: readonly string[]
  /** Logical-key match (`KeyboardEvent.key`). */
  readonly keys?: readonly string[]
  /** Required shift state; absent = either. */
  readonly shift?: boolean
  /**
   * Requires the platform command modifier — Cmd (metaKey) on macOS or
   * Ctrl (ctrlKey) elsewhere; either satisfies it. Absent = the spec never
   * fires while meta/ctrl is held (the historic default: browser combos
   * stay the browser's until a spec explicitly claims one).
   */
  readonly mod?: boolean
  /** Requires Alt/Option held. Absent = never fires while Alt is held. */
  readonly alt?: boolean
  /** Human-readable combo for menus and a future help sheet. */
  readonly display: string
  readonly description: string
  /** Tools the shortcut is live in; absent = every tool. */
  readonly tools?: readonly EditorTool[]
  /** Declared-only: handled by a bespoke branch in handleKeyDown. */
  readonly handledInline?: boolean
}

export const EDITOR_SHORTCUTS: readonly ShortcutSpec[] = [
  // Single unmodified letters: `matchesSpec` compares `mod` exactly, so these
  // never answer Cmd+C / Cmd+V / Cmd+D, which stay the clipboard and
  // duplicate chords. Live in every tool — switching away from a tool must
  // work from inside it.
  {
    id: 'tool-select',
    section: 'Tools',
    keys: ['v'],
    display: 'V',
    description: 'Select tool',
  },
  {
    id: 'tool-hand',
    section: 'Tools',
    keys: ['h'],
    display: 'H',
    description: 'Hand tool (pan)',
  },
  {
    id: 'tool-connect',
    section: 'Tools',
    keys: ['c'],
    display: 'C',
    description: 'Connect tool; with a node selected, connect from that node',
  },
  // Live only while a connect or re-attach is armed, so the arrows keep
  // meaning "nudge" everywhere else; dispatched ahead of the table.
  {
    id: 'connect-pick-target',
    section: 'Navigate',
    keys: ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'],
    display: 'Arrows',
    description: 'While connecting, choose the target (Enter connects, Esc cancels)',
    handledInline: true,
  },
  {
    id: 'tool-draw',
    section: 'Tools',
    keys: ['d'],
    display: 'D',
    description: 'Draw tool',
  },
  {
    id: 'new-note',
    section: 'Tools',
    keys: ['n'],
    display: 'N',
    description: 'Add a note at the centre of the view',
  },
  // Keyboard traversal of existing nodes. Table-dispatched, but only when the
  // canvas root itself holds focus: a Tab or Enter that originates in the dock,
  // a handle or a connect target belongs to that control.
  {
    id: 'select-next-node',
    section: 'Navigate',
    keys: ['Tab'],
    shift: false,
    display: 'Tab',
    description:
      'Select the next node in reading order (the first, when none is selected); past the last node Tab leaves the canvas',
    tools: ['select'],
  },
  {
    id: 'select-previous-node',
    section: 'Navigate',
    keys: ['Tab'],
    shift: true,
    display: 'Shift+Tab',
    description:
      'Select the previous node in reading order; before the first node Shift+Tab leaves the canvas',
    tools: ['select'],
  },
  {
    id: 'select-adjacent-node',
    section: 'Navigate',
    keys: ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'],
    mod: true,
    display: 'Cmd+Arrows',
    description: 'Select the nearest node in that direction',
    tools: ['select'],
  },
  {
    id: 'edit-selected-node',
    section: 'Navigate',
    keys: ['Enter', 'F2'],
    display: 'Enter',
    description: "Edit the selected node's text, or a group's label (also F2)",
    tools: ['select'],
  },
  // The keyboard's right-click: the SELECTION's menu (the canvas's when
  // nothing is selected), the one vessel a pointer reaches by right-click.
  // Two rows because the Menu key takes any shift state while F10 alone is
  // not ours to claim.
  {
    id: 'open-context-menu',
    section: 'Navigate',
    keys: ['ContextMenu'],
    display: 'Menu',
    description: "Open the selection's menu (the canvas menu when nothing is selected)",
    tools: ['select'],
  },
  {
    id: 'open-context-menu-shift-f10',
    section: 'Navigate',
    keys: ['F10'],
    shift: true,
    display: 'Shift+F10',
    description: "Open the selection's menu (the canvas menu when nothing is selected)",
    tools: ['select'],
  },
  {
    id: 'toggle-lock',
    section: 'Edit',
    keys: ['l'],
    mod: true,
    shift: true,
    display: 'Cmd+Shift+L',
    description: 'Lock or unlock the selection',
    tools: ['select'],
  },
  // Cmd+Alt+M is the comment chord of the document editors people already
  // use. The physical key (`codes`) because Option rewrites `key` on macOS;
  // the markdown editor's chords (B, I, E, K, Enter) are all Cmd-only, so
  // none collides.
  {
    id: 'comment-on-selection',
    section: 'Edit',
    codes: ['KeyM'],
    mod: true,
    alt: true,
    display: 'Cmd+Alt+M',
    description: 'Comment on the selected node, nodes or edge',
    tools: ['select'],
  },
  // Viewport framing (tldraw combos). Live in every tool — navigation is
  // never mode-gated.
  {
    id: 'zoom-to-fit',
    section: 'View',
    codes: ['Digit1'],
    shift: true,
    display: 'Shift+1',
    description: 'Zoom to fit all content',
  },
  // Step zoom exists ONLY here. The dock offers "see everything" and the
  // pointer gets closer by double-pressing in hand mode or by the wheel —
  // neither of which a keyboard-only or switch-access user can perform, and
  // fit-to-content is not a magnification they can choose. Unmodified +/-
  // rather than Cmd+= : that combination is the browser's own page zoom,
  // which is a different function and not ours to take.
  {
    id: 'zoom-in',
    section: 'View',
    keys: ['+', '='],
    display: '+',
    description: 'Zoom in',
  },
  {
    id: 'zoom-out',
    section: 'View',
    keys: ['-'],
    display: '-',
    description: 'Zoom out',
  },
  {
    id: 'zoom-to-selection',
    section: 'View',
    codes: ['Digit2'],
    shift: true,
    display: 'Shift+2',
    description: 'Zoom to the selection',
  },
  // Its handler answers true even on an empty canvas: false would let the
  // chord fall through to the browser's own select-all, highlighting the whole
  // page, so a handled no-op still consumes it.
  {
    id: 'select-all',
    section: 'Edit',
    keys: ['a'],
    mod: true,
    display: 'Cmd+A',
    description: 'Select every node',
    tools: ['select'],
  },
  // Clipboard family — declared here for catalog completeness, but handled
  // by the NATIVE copy/cut/paste DOM events (handledInline): a keydown
  // preventDefault on the chord would suppress the very event that carries
  // `clipboardData`, which is what crosses tabs and what lets foreign text
  // degrade into a note.
  {
    id: 'copy-selection',
    section: 'Edit',
    keys: ['c'],
    mod: true,
    display: 'Cmd+C',
    description: 'Copy the selection',
    tools: ['select'],
    handledInline: true,
  },
  {
    id: 'cut-selection',
    section: 'Edit',
    keys: ['x'],
    mod: true,
    display: 'Cmd+X',
    description: 'Cut the selection',
    tools: ['select'],
    handledInline: true,
  },
  {
    id: 'paste-clipboard',
    section: 'Edit',
    keys: ['v'],
    mod: true,
    display: 'Cmd+V',
    description: 'Paste the copied nodes',
    tools: ['select'],
    handledInline: true,
  },
  {
    id: 'duplicate-selection',
    section: 'Edit',
    keys: ['d'],
    mod: true,
    display: 'Cmd+D',
    description: 'Duplicate the selection',
    tools: ['select'],
  },
  // Z-order (tldraw parity). Array order is z-order, last = topmost.
  {
    id: 'reorder-forward',
    section: 'Arrange',
    codes: ['BracketRight'],
    shift: false,
    display: ']',
    description: 'Bring forward',
    tools: ['select'],
  },
  {
    id: 'reorder-backward',
    section: 'Arrange',
    codes: ['BracketLeft'],
    shift: false,
    display: '[',
    description: 'Send backward',
    tools: ['select'],
  },
  {
    id: 'reorder-front',
    section: 'Arrange',
    codes: ['BracketRight'],
    shift: true,
    display: 'Shift+]',
    description: 'Bring to front',
    tools: ['select'],
  },
  {
    id: 'reorder-back',
    section: 'Arrange',
    codes: ['BracketLeft'],
    shift: true,
    display: 'Shift+[',
    description: 'Send to back',
    tools: ['select'],
  },
  // Pre-table bindings, declared for catalog completeness.
  //
  // The text-edit pair below live in the OVERLAY EDITORS
  // (`MarkdownNodeEditor` for a node's body, `TextNodeEditor` for an edge
  // or group label), not in `handleKeyDown`, and they were absent from
  // this catalog until someone went looking for "how do I save?" and
  // could not find it. `findShortcut` would refuse them anyway —
  // `isTextEntryEvent` returns before any spec is matched, which is
  // exactly right for a binding whose whole job is to work while typing —
  // so they are declared, never dispatched, like the clipboard family
  // above.
  {
    id: 'commit-text-edit',
    section: 'Text',
    keys: ['Enter'],
    mod: true,
    display: 'Cmd+Enter',
    description: 'Save the text being edited and close the editor',
    handledInline: true,
  },
  // Undo/redo are handled by the document pane's own listener (they step the
  // whole document's history, not the canvas), so they are declared, never
  // dispatched from here.
  {
    id: 'undo',
    section: 'Edit',
    keys: ['z'],
    mod: true,
    shift: false,
    display: 'Cmd+Z',
    description: 'Undo',
    handledInline: true,
  },
  {
    id: 'redo',
    section: 'Edit',
    keys: ['z', 'y'],
    mod: true,
    display: 'Cmd+Shift+Z',
    description: 'Redo (also Cmd+Y)',
    handledInline: true,
  },
  {
    id: 'delete-selection',
    section: 'Edit',
    keys: ['Delete', 'Backspace'],
    display: 'Delete',
    description: 'Delete the selected node(s) or edge',
    handledInline: true,
  },
  // Escape peels one layer per press: a gesture in flight first — in a text
  // edit that means DISCARDING what was typed, with three outcomes worth
  // knowing: an existing node keeps its committed text, a just-created note
  // carrying typed text goes with the discard, and a just-created note with
  // nothing typed survives as the empty box someone sketching a layout meant
  // to leave — then a pending cut's hold, then the selection. With nothing
  // left it hands Tab back to the browser, which is the way from the canvas to
  // the dock.
  {
    id: 'cancel',
    section: 'Edit',
    keys: ['Escape'],
    display: 'Esc',
    description: 'Cancel the gesture or clear the selection; discards text being edited',
    handledInline: true,
  },
  {
    id: 'space-pan',
    section: 'View',
    keys: [' '],
    display: 'Space+drag',
    description: 'Pan while held',
    handledInline: true,
  },
  {
    id: 'nudge-selection',
    section: 'Arrange',
    keys: ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'],
    display: 'Arrows',
    description: 'Nudge the selected node (Shift: larger step)',
    handledInline: true,
  },
  // Matched by `findShortcut` like any table row; the editor root opens the
  // sheet, since the sheet's open state belongs to the host of the dock's
  // Help button, not to the gesture hook.
  {
    id: 'show-shortcuts',
    section: 'Help',
    keys: ['?'],
    display: '?',
    description: 'Show keyboard shortcuts',
  },
]

/** True when the event originates in a surface that consumes typing. */
export function isTextEntryEvent(e: { readonly target: EventTarget | null }): boolean {
  const target = e.target
  if (!(target instanceof HTMLElement)) return false
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable
}

interface KeyEventLike {
  readonly code: string
  readonly key: string
  readonly shiftKey: boolean
  readonly altKey: boolean
  readonly metaKey: boolean
  readonly ctrlKey: boolean
  readonly target: EventTarget | null
}

/**
 * The first table-dispatched shortcut matching the event in `tool`, or
 * undefined. Never fires while typing. Modifier policy: a held meta/ctrl
 * suppresses every spec except one declaring `mod: true` (which requires
 * it — Cmd or Ctrl, either platform's command chord); a held Alt likewise
 * belongs only to specs declaring `alt: true`. Combos a spec does not
 * claim stay the browser's.
 */
export function findShortcut(e: KeyEventLike, tool: EditorTool): ShortcutSpec | undefined {
  return findShortcutIn(EDITOR_SHORTCUTS, e, tool)
}

/**
 * Whether one spec matches this key event.
 *
 * Every modifier is compared EXACTLY, not as "at least": a spec that does not
 * declare `alt` must not fire while Alt is held, or two chords answer the
 * same press. The key comparison is case-insensitive because a shifted
 * command chord (Cmd+Shift+C) reports an uppercase key while the spec
 * declares the plain character. A spec that names neither a code nor a key
 * matches nothing at all.
 */
function matchesSpec(
  spec: ShortcutSpec,
  e: KeyEventLike,
  tool: EditorTool,
  hasMod: boolean,
): boolean {
  if (spec.handledInline === true) return false
  if (spec.tools !== undefined && !spec.tools.includes(tool)) return false
  if ((spec.mod === true) !== hasMod) return false
  if ((spec.alt === true) !== e.altKey) return false
  if (spec.shift !== undefined && spec.shift !== e.shiftKey) return false
  if (spec.codes !== undefined && !spec.codes.includes(e.code)) return false
  if (
    spec.keys !== undefined &&
    !spec.keys.some((key) => key.toLowerCase() === e.key.toLowerCase())
  ) {
    return false
  }
  return spec.codes !== undefined || spec.keys !== undefined
}

/** `findShortcut` over an explicit spec list — the testable pure core. */
export function findShortcutIn(
  specs: readonly ShortcutSpec[],
  e: KeyEventLike,
  tool: EditorTool,
): ShortcutSpec | undefined {
  if (isTextEntryEvent(e)) return undefined
  const hasMod = e.metaKey || e.ctrlKey
  return specs.find((spec) => matchesSpec(spec, e, tool, hasMod))
}
