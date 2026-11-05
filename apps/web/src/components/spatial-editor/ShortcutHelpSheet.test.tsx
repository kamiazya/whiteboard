import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ShortcutHelpSheet } from './ShortcutHelpSheet.js'
import { shortcutLabel } from './shortcut-labels.js'
import { EDITOR_SHORTCUTS, SHORTCUT_SECTIONS } from './shortcuts.js'

afterEach(cleanup)

describe('ShortcutHelpSheet', () => {
  it('lists exactly the catalog rows, each with its description and key label', () => {
    render(<ShortcutHelpSheet open onOpenChange={() => {}} />)
    const sheet = screen.getByTestId('shortcut-help-sheet')
    const rows = [...sheet.querySelectorAll('[data-shortcut-id]')]
    expect(EDITOR_SHORTCUTS.length).toBeGreaterThan(15)
    expect(rows.map((row) => row.getAttribute('data-shortcut-id'))).toHaveLength(
      EDITOR_SHORTCUTS.length,
    )
    for (const spec of EDITOR_SHORTCUTS) {
      const row = sheet.querySelector(`[data-shortcut-id="${spec.id}"]`) as HTMLElement
      expect(row, spec.id).not.toBeNull()
      expect(within(row).getByText(spec.description)).toBeTruthy()
      expect(within(row).getByText(shortcutLabel(spec.display))).toBeTruthy()
    }
  })

  it('groups rows under their section heading', () => {
    render(<ShortcutHelpSheet open onOpenChange={() => {}} />)
    const sheet = screen.getByTestId('shortcut-help-sheet')
    for (const section of SHORTCUT_SECTIONS) {
      const expected = EDITOR_SHORTCUTS.filter((spec) => spec.section === section)
      expect(expected.length, section).toBeGreaterThan(0)
      const group = sheet.querySelector(`section[aria-labelledby="shortcut-section-${section}"]`)
      expect(group, section).not.toBeNull()
      expect(group?.querySelectorAll('[data-shortcut-id]')).toHaveLength(expected.length)
    }
  })

  it('lists undo and redo, which the document pane handles', () => {
    render(<ShortcutHelpSheet open onOpenChange={() => {}} />)
    const sheet = screen.getByTestId('shortcut-help-sheet')
    expect(within(sheet).getByText('Undo')).toBeTruthy()
    expect(within(sheet).getByText(/^Redo/)).toBeTruthy()
  })

  it('points to the right-click menu for the arrange actions that have no key', () => {
    render(<ShortcutHelpSheet open onOpenChange={() => {}} />)
    const note = screen.getByTestId('shortcut-help-menu-only')
    expect(note.textContent).toMatch(/Align/)
    expect(note.textContent).toMatch(/Distribute/)
    expect(note.textContent).toMatch(/Tidy/)
    expect(note.textContent).toMatch(/Frame selection/)
    expect(note.textContent).toMatch(/right-click/i)
  })

  it('names the keyboard way into those menus beside right-click', () => {
    render(<ShortcutHelpSheet open onOpenChange={() => {}} />)
    const text = screen.getByTestId('shortcut-help-menu-only').textContent ?? ''
    expect(text).toMatch(/Shift\+F10/)
  })

  // The Hand tool's right-click offers comments only, so the arrange
  // actions are reached from the Select tool — and Align/Distribute from a
  // selection of two or more nodes, the only menu that carries them.
  it('says the arrange actions need the Select tool and a multi-node selection', () => {
    render(<ShortcutHelpSheet open onOpenChange={() => {}} />)
    const text = screen.getByTestId('shortcut-help-menu-only').textContent ?? ''
    expect(text).toMatch(/Select tool \(V\)/)
    expect(text).toMatch(/two or more/)
  })

  it('renders nothing while closed', () => {
    render(<ShortcutHelpSheet open={false} onOpenChange={() => {}} />)
    expect(screen.queryByTestId('shortcut-help-sheet')).toBeNull()
  })
})

describe('ShortcutHelpSheet comment row', () => {
  it('lists the comment-on-selection shortcut with its platform label', () => {
    render(<ShortcutHelpSheet open onOpenChange={() => {}} />)
    const row = screen
      .getByTestId('shortcut-help-sheet')
      .querySelector('[data-shortcut-id="comment-on-selection"]') as HTMLElement
    expect(row).not.toBeNull()
    expect(within(row).getByText(shortcutLabel('Cmd+Alt+M'))).toBeTruthy()
  })
})
