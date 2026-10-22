/**
 * How the catalog's combos are written for a person and for assistive tech.
 *
 * `ShortcutSpec.display` is spelled once, in platform-neutral words
 * ("Cmd+Shift+L"); this module is the only place that turns it into the
 * platform's own — ⌘⇧L on a Mac, Ctrl+Shift+L elsewhere — so a help sheet, a
 * tooltip and an `aria-keyshortcuts` value can never disagree about it.
 */
import { isMacPlatform } from '../../lib/platform.js'
import { EDITOR_SHORTCUTS, type ShortcutId } from './shortcuts.js'

const MAC_GLYPH: Readonly<Record<string, string>> = { Cmd: '⌘', Shift: '⇧', Alt: '⌥' }
const ARIA_NAME: Readonly<Record<string, string>> = {
  Cmd: 'Meta',
  Ctrl: 'Control',
  Esc: 'Escape',
}

/**
 * The parts of a combo. A `+` is split only when a key follows it, so the
 * zoom-in binding (display "+") stays one part.
 */
function comboParts(display: string): readonly string[] {
  return display.split(/\+(?=.)/)
}

function specFor(id: ShortcutId) {
  return EDITOR_SHORTCUTS.find((spec) => spec.id === id)
}

/** The combo as drawn in chrome: "⌘⇧L" on a Mac, "Ctrl+Shift+L" elsewhere. */
export function shortcutLabel(display: string, mac: boolean = isMacPlatform()): string {
  const parts = comboParts(display)
  if (mac) return parts.map((part) => MAC_GLYPH[part] ?? part).join('')
  return parts.map((part) => (part === 'Cmd' ? 'Ctrl' : part)).join('+')
}

/** The combo of a catalog row; the row must exist (the id type guarantees it). */
function shortcutLabelFor(id: ShortcutId, mac: boolean = isMacPlatform()): string {
  const spec = specFor(id)
  if (spec === undefined) throw new Error(`no catalog row for shortcut ${id}`)
  return shortcutLabel(spec.display, mac)
}

/** A tooltip's text with the row's combo appended: "Zoom to fit (Shift+1)". */
export function withShortcut(text: string, id: ShortcutId, mac: boolean = isMacPlatform()): string {
  return `${text} (${shortcutLabelFor(id, mac)})`
}

/** The `aria-keyshortcuts` value for a row ("Meta+Shift+L" / "Control+Shift+L"). */
export function shortcutAriaKeysFor(id: ShortcutId, mac: boolean = isMacPlatform()): string {
  const spec = specFor(id)
  if (spec === undefined) throw new Error(`no catalog row for shortcut ${id}`)
  return comboParts(spec.display)
    .map((part) => (part === 'Cmd' && !mac ? 'Control' : (ARIA_NAME[part] ?? part)))
    .join('+')
}
