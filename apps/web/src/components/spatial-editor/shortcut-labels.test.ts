import { describe, expect, it } from 'vitest'
import { shortcutAriaKeysFor, shortcutLabel, withShortcut } from './shortcut-labels.js'
import { EDITOR_SHORTCUTS } from './shortcuts.js'

describe('shortcut labels', () => {
  it('writes the command modifier as ⌘ on a Mac and Ctrl elsewhere', () => {
    expect(shortcutLabel('Cmd+Shift+L', true)).toBe('⌘⇧L')
    expect(shortcutLabel('Cmd+Shift+L', false)).toBe('Ctrl+Shift+L')
  })

  it('keeps a bare + key as one key', () => {
    expect(withShortcut('Zoom in', 'zoom-in', false)).toBe('Zoom in (+)')
    expect(shortcutLabel('+', true)).toBe('+')
  })

  it('appends the catalog combo to tooltip text', () => {
    expect(withShortcut('Zoom to fit', 'zoom-to-fit', false)).toBe('Zoom to fit (Shift+1)')
    expect(withShortcut('Zoom to fit', 'zoom-to-fit', true)).toBe('Zoom to fit (⇧1)')
  })

  it('names modifiers the way aria-keyshortcuts spells them', () => {
    expect(shortcutAriaKeysFor('toggle-lock', true)).toBe('Meta+Shift+L')
    expect(shortcutAriaKeysFor('toggle-lock', false)).toBe('Control+Shift+L')
    expect(shortcutAriaKeysFor('cancel', false)).toBe('Escape')
  })

  it('never leaks a platform-neutral word into either platform', () => {
    for (const spec of EDITOR_SHORTCUTS) {
      expect(shortcutLabel(spec.display, true)).not.toMatch(/Cmd/)
      expect(shortcutLabel(spec.display, false)).not.toMatch(/Cmd/)
    }
  })
})
