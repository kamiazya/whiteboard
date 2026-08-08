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
  | 'reorder-forward'
  | 'reorder-backward'
  | 'reorder-front'
  | 'reorder-back'
  | 'delete-selection'
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
  {
    id: 'delete-selection',
    keys: ['Delete', 'Backspace'],
    display: 'Delete',
    description: 'Delete the selected node(s) or edge',
    handledInline: true,
  },
  {
    id: 'cancel',
    keys: ['Escape'],
    display: 'Esc',
    description: 'Cancel the gesture / clear the selection',
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
