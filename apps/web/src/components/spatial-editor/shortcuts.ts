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
import type { EditorTool } from './ToolPalette.js'

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

export interface ShortcutSpec {
  readonly id: ShortcutId
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
  {
    id: 'toggle-lock',
    keys: ['l'],
    mod: true,
    shift: true,
    display: 'Cmd+Shift+L',
    description: 'Lock or unlock the selection',
    tools: ['select'],
  },
  // Viewport framing (tldraw combos). Live in every tool — navigation is
  // never mode-gated.
  {
    id: 'zoom-to-fit',
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
    keys: ['+', '='],
    display: '+',
    description: 'Zoom in',
  },
  {
    id: 'zoom-out',
    keys: ['-'],
    display: '-',
    description: 'Zoom out',
  },
  {
    id: 'zoom-to-selection',
    codes: ['Digit2'],
    shift: true,
    display: 'Shift+2',
    description: 'Zoom to the selection',
  },
  {
    id: 'select-all',
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
    keys: ['c'],
    mod: true,
    display: 'Cmd+C',
    description: 'Copy the selection',
    tools: ['select'],
    handledInline: true,
  },
  {
    id: 'cut-selection',
    keys: ['x'],
    mod: true,
    display: 'Cmd+X',
    description: 'Cut the selection',
    tools: ['select'],
    handledInline: true,
  },
  {
    id: 'paste-clipboard',
    keys: ['v'],
    mod: true,
    display: 'Cmd+V',
    description: 'Paste the copied nodes',
    tools: ['select'],
    handledInline: true,
  },
  {
    id: 'duplicate-selection',
    keys: ['d'],
    mod: true,
    display: 'Cmd+D',
    description: 'Duplicate the selection',
    tools: ['select'],
  },
  // Z-order (tldraw parity). Array order is z-order, last = topmost.
  {
    id: 'reorder-forward',
    codes: ['BracketRight'],
    shift: false,
    display: ']',
    description: 'Bring forward',
    tools: ['select'],
  },
  {
    id: 'reorder-backward',
    codes: ['BracketLeft'],
    shift: false,
    display: '[',
    description: 'Send backward',
    tools: ['select'],
  },
  {
    id: 'reorder-front',
    codes: ['BracketRight'],
    shift: true,
    display: 'Shift+]',
    description: 'Bring to front',
    tools: ['select'],
  },
  {
    id: 'reorder-back',
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
    keys: ['Enter'],
    mod: true,
    display: 'Cmd+Enter',
    description: 'Save the text being edited and close the editor',
    handledInline: true,
  },
  {
    id: 'delete-selection',
    keys: ['Delete', 'Backspace'],
    display: 'Delete',
    description: 'Delete the selected node(s) or edge',
    handledInline: true,
  },
  // Escape does NOT clear a node selection, which this entry used to
  // claim: `handleKeyDown`'s gesture arm requires a gesture in flight, and
  // its earlier arms only retire an edge selection or a pending cut. What
  // it cancels is the gesture — and in a text edit that means DISCARDING
  // what was typed, with three outcomes worth knowing: an existing node
  // keeps its committed text, a just-created note carrying typed text goes
  // with the discard, and a just-created note with nothing typed survives
  // as the empty box someone sketching a layout meant to leave.
  {
    id: 'cancel',
    keys: ['Escape'],
    display: 'Esc',
    description: 'Cancel the gesture, discarding text being edited',
    handledInline: true,
  },
  {
    id: 'space-pan',
    keys: [' '],
    display: 'Space+drag',
    description: 'Pan while held',
    handledInline: true,
  },
  {
    id: 'nudge-selection',
    keys: ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'],
    display: 'Arrows',
    description: 'Nudge the selected node (Shift: larger step)',
    handledInline: true,
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

/** `findShortcut` over an explicit spec list — the testable pure core. */
export function findShortcutIn(
  specs: readonly ShortcutSpec[],
  e: KeyEventLike,
  tool: EditorTool,
): ShortcutSpec | undefined {
  if (isTextEntryEvent(e)) return undefined
  const hasMod = e.metaKey || e.ctrlKey
  return specs.find((spec) => {
    if (spec.handledInline === true) return false
    if (spec.tools !== undefined && !spec.tools.includes(tool)) return false
    if ((spec.mod === true) !== hasMod) return false
    if ((spec.alt === true) !== e.altKey) return false
    if (spec.shift !== undefined && spec.shift !== e.shiftKey) return false
    if (spec.codes !== undefined && !spec.codes.includes(e.code)) return false
    // Case-insensitive on key: shifted command chords (Cmd+Shift+C) report
    // an uppercase key while the spec declares the plain character.
    if (
      spec.keys !== undefined &&
      !spec.keys.some((key) => key.toLowerCase() === e.key.toLowerCase())
    ) {
      return false
    }
    return spec.codes !== undefined || spec.keys !== undefined
  })
}
