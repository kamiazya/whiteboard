/**
 * The workspace section of the mark's popover.
 *
 * Rendered directly, because it IS content — the mark owns the trigger and
 * the popover, and the shell owns the row fetch since its head names the
 * current workspace. What used to be asserted here about a trigger label
 * now lives in `AppShell.test.tsx`, on the mark.
 */
import type { WorkspaceEntry } from '@kamiazya/whiteboard-ports'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceMenu, type WorkspaceSwitcherSource } from './WorkspaceMenu.js'

const DESIGN = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const NOTES = '01BX5ZZKBKACTAV9WEVGEMMVRZ'

const listOnly: WorkspaceSwitcherSource = { list: () => Promise.resolve([]) }

function renderMenu(
  workspaces: WorkspaceEntry[],
  source: Partial<WorkspaceSwitcherSource> = {},
  {
    onSwitch = vi.fn(),
    onRenamed = vi.fn(),
    current = 'design',
  }: { onSwitch?: () => void; onRenamed?: (entry: WorkspaceEntry) => void; current?: string } = {},
) {
  render(
    <WorkspaceMenu
      current={current}
      workspaces={workspaces}
      source={{ ...listOnly, ...source }}
      onSwitch={onSwitch}
      onRenamed={onRenamed}
    />,
  )
}

afterEach(cleanup)

describe('WorkspaceMenu — switching', () => {
  it('switches by the target workspace HANDLE, never by its label', () => {
    // A display name is free text with no uniqueness duty and no charset
    // rule — it cannot address anything. The handle is the segment when
    // there is one, so this asserts the layer, not the string.
    const onSwitch = vi.fn()
    renderMenu(
      [
        { workspaceId: DESIGN, segment: 'design', displayName: 'Design team' },
        { workspaceId: NOTES, segment: 'notes', displayName: 'Notes & ideas' },
      ],
      {},
      { onSwitch },
    )
    fireEvent.click(screen.getByRole('menuitem', { name: /notes & ideas/i }))
    expect(onSwitch).toHaveBeenCalledWith('notes')
  })

  it('addresses a workspace with no segment by its canonical id', () => {
    // The id form is not a lesser answer (ADR-0019) — it is what an unnamed
    // workspace is addressed by, and the menu must be able to reach one.
    const onSwitch = vi.fn()
    renderMenu(
      [
        { workspaceId: DESIGN, segment: 'design' },
        { workspaceId: NOTES, displayName: 'Unnamed' },
      ],
      {},
      { onSwitch },
    )
    fireEvent.click(screen.getByRole('menuitem', { name: /unnamed/i }))
    expect(onSwitch).toHaveBeenCalledWith(NOTES)
  })

  it('marks the current workspace and does not re-switch to it', () => {
    const onSwitch = vi.fn()
    renderMenu(
      [{ workspaceId: DESIGN, segment: 'design', displayName: 'Design team' }],
      {},
      {
        onSwitch,
      },
    )
    const current = screen.getByRole('menuitem', { name: /design team/i })
    expect(current.getAttribute('aria-current')).toBe('true')
    fireEvent.click(current)
    expect(onSwitch).not.toHaveBeenCalled()
  })
})

describe('WorkspaceMenu — creating', () => {
  it('renders its glyphs as glyphs, not as escape sequences', () => {
    // Caught by a screenshot, not by a test: the accessible-name queries all
    // matched "New workspace" while a literal `\\uff0b` sat beside it, because
    // the corruption was in a SEPARATE aria-hidden span. A query that reads
    // the name it wants cannot see the text it did not ask for.
    renderMenu([{ workspaceId: DESIGN, segment: 'design', displayName: 'Design team' }], {
      create: () => Promise.reject(new Error('not expected')),
      rename: () => Promise.reject(new Error('not expected')),
    })
    for (const menu of screen.getAllByRole('menu')) {
      expect(menu.textContent).not.toMatch(/\\u[0-9a-f]{4}/i)
    }
  })

  it('offers creation even with a single workspace, since that is the only way to a second', () => {
    renderMenu([{ workspaceId: DESIGN, segment: 'design' }], {
      create: () => Promise.reject(new Error('not expected')),
    })
    expect(screen.getByRole('menuitem', { name: /new workspace/i })).toBeTruthy()
  })

  it('switches to the handle CREATE answered with, not to the name that was typed', async () => {
    // A segment is DERIVED from the name and may be suffixed past a
    // collision, or absent entirely. Navigating to what was typed addresses
    // nothing.
    const onSwitch = vi.fn()
    renderMenu(
      [{ workspaceId: DESIGN, segment: 'design' }],
      {
        create: () =>
          Promise.resolve({ workspaceId: NOTES, segment: 'design-2', displayName: 'Design' }),
      },
      { onSwitch },
    )
    fireEvent.click(screen.getByRole('menuitem', { name: /new workspace/i }))
    fireEvent.change(screen.getByLabelText(/new workspace name/i), { target: { value: 'Design' } })
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }))
    await waitFor(() => expect(onSwitch).toHaveBeenCalledWith('design-2'))
  })

  it('creates once when Create is pressed twice before the first settles', async () => {
    // Dispatched raw inside ONE act, which is what reaches the guard: two
    // `fireEvent` calls flush between them and call `create` once with no
    // guard at all. Each browser create MINTS and persists a workspace.
    const create = vi.fn(
      () =>
        new Promise<WorkspaceEntry>((resolve) =>
          setTimeout(() => resolve({ workspaceId: NOTES, segment: 'design-2' }), 10),
        ),
    )
    renderMenu([{ workspaceId: DESIGN, segment: 'design' }], { create })
    fireEvent.click(screen.getByRole('menuitem', { name: /new workspace/i }))
    const input = screen.getByLabelText(/new workspace name/i)
    fireEvent.change(input, { target: { value: 'Design' } })
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('surfaces a create failure in the form and stays put', async () => {
    // Navigating away from a workspace that was not created would land on a
    // fallback and read as success.
    const onSwitch = vi.fn()
    renderMenu(
      [{ workspaceId: DESIGN, segment: 'design' }],
      { create: () => Promise.reject(new Error('that name is taken')) },
      { onSwitch },
    )
    fireEvent.click(screen.getByRole('menuitem', { name: /new workspace/i }))
    fireEvent.change(screen.getByLabelText(/new workspace name/i), { target: { value: 'Design' } })
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }))
    expect((await screen.findByRole('alert')).textContent).toContain('that name is taken')
    expect(onSwitch).not.toHaveBeenCalled()
  })

  it('offers no creation when the keeper has no way to create one', () => {
    // DESIGN.md's standing rule: never offer what the keeper cannot honour.
    // The daemon has no create surface yet. Absent, not disabled.
    renderMenu([
      { workspaceId: DESIGN, segment: 'design', displayName: 'Design team' },
      { workspaceId: NOTES, segment: 'notes', displayName: 'Notes' },
    ])
    // The subject is PRESENT — the list really rendered — so the absence
    // below is a decision and not a menu that never mounted.
    expect(screen.getByRole('menuitem', { name: /notes/i })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: /new workspace/i })).toBeNull()
  })
})

describe('WorkspaceMenu — naming, in place', () => {
  const DESIGN_ROW: WorkspaceEntry = {
    workspaceId: DESIGN,
    segment: 'design',
    displayName: 'Design team',
  }

  it('names the workspace in an editable field, not behind a menu item', () => {
    // The same shape the DOCUMENT layer already settled on: this repo deleted
    // the pencil-menu rename for a title you edit directly, and ADR-0006 says
    // an object is "named in place afterwards". A `Rename workspace` item
    // would be that retired shape rebuilt one layer up.
    renderMenu([DESIGN_ROW], { rename: () => Promise.resolve(DESIGN_ROW) })
    expect(screen.getByLabelText(/^workspace name$/i)).toHaveProperty('value', 'Design team')
    expect(screen.getByLabelText(/workspace url/i)).toHaveProperty('value', 'design')
    expect(screen.queryByRole('menuitem', { name: /rename workspace/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /^save$/i })).toBeNull()
  })

  it('commits a name edit on the keystroke, the way a document title does', async () => {
    const rename = vi.fn(() =>
      Promise.resolve({ workspaceId: DESIGN, segment: 'design', displayName: 'Marketing' }),
    )
    const onRenamed = vi.fn()
    renderMenu([DESIGN_ROW], { rename }, { onRenamed })
    fireEvent.change(screen.getByLabelText(/^workspace name$/i), { target: { value: 'Marketing' } })

    await waitFor(() => expect(onRenamed).toHaveBeenCalled())
    expect(rename).toHaveBeenCalledWith(DESIGN, { displayName: 'Marketing' })
  })

  it('puts the previous name back on Escape', async () => {
    // Every keystroke is already committed, so Escape has nothing to discard
    // — it has to write the previous name BACK, or "type, change your mind,
    // Escape" silently keeps the half-typed one. Same rule as the title box.
    const rename = vi.fn((_id: string, input: { displayName?: string }) =>
      Promise.resolve({ ...DESIGN_ROW, ...input }),
    )
    renderMenu([DESIGN_ROW], { rename })
    const field = screen.getByLabelText(/^workspace name$/i)
    fireEvent.change(field, { target: { value: 'Marketin' } })
    await waitFor(() => expect(rename).toHaveBeenCalledWith(DESIGN, { displayName: 'Marketin' }))

    fireEvent.keyDown(field, { key: 'Escape' })
    await waitFor(() =>
      expect(rename).toHaveBeenLastCalledWith(DESIGN, { displayName: 'Design team' }),
    )
  })

  it('holds the URL until the edit is committed, unlike the name', async () => {
    // A segment commit MOVES the address and navigates. Per-keystroke would
    // move it once per character, through intermediate values that are real
    // addresses and can collide — so this field waits for Enter or blur.
    const rename = vi.fn(() =>
      Promise.resolve({ workspaceId: DESIGN, segment: 'marketing', displayName: 'Design team' }),
    )
    const onSwitch = vi.fn()
    renderMenu([DESIGN_ROW], { rename }, { onSwitch })
    const url = screen.getByLabelText(/workspace url/i)
    fireEvent.change(url, { target: { value: 'marketing' } })
    expect(rename).not.toHaveBeenCalled()

    fireEvent.keyDown(url, { key: 'Enter' })
    await waitFor(() => expect(rename).toHaveBeenCalledWith(DESIGN, { segment: 'marketing' }))
    await waitFor(() => expect(onSwitch).toHaveBeenCalledWith('marketing'))
  })

  it('commits a URL edit on blur too, so leaving the field is not a silent discard', async () => {
    const rename = vi.fn(() =>
      Promise.resolve({ workspaceId: DESIGN, segment: 'marketing', displayName: 'Design team' }),
    )
    renderMenu([DESIGN_ROW], { rename })
    const url = screen.getByLabelText(/workspace url/i)
    fireEvent.change(url, { target: { value: 'marketing' } })
    fireEvent.blur(url)
    await waitFor(() => expect(rename).toHaveBeenCalledWith(DESIGN, { segment: 'marketing' }))
  })

  it('warns about broken links only once the URL actually differs', () => {
    // Permanently visible, the warning is furniture nobody reads. It belongs
    // exactly when the edit in the box would break something.
    renderMenu([DESIGN_ROW], { rename: () => Promise.resolve(DESIGN_ROW) })
    expect(screen.queryByText(/links using the old url stop working/i)).toBeNull()
    fireEvent.change(screen.getByLabelText(/workspace url/i), { target: { value: 'marketing' } })
    expect(screen.getByText(/links using the old url stop working/i)).toBeTruthy()
  })

  it('reverts an uncommitted URL edit on Escape, without writing', () => {
    const rename = vi.fn(() => Promise.resolve(DESIGN_ROW))
    renderMenu([DESIGN_ROW], { rename })
    const url = screen.getByLabelText(/workspace url/i)
    fireEvent.change(url, { target: { value: 'marketing' } })
    fireEvent.keyDown(url, { key: 'Escape' })
    expect(url).toHaveProperty('value', 'design')
    expect(rename).not.toHaveBeenCalled()
  })

  it('surfaces a taken URL and stays put', async () => {
    const onSwitch = vi.fn()
    renderMenu(
      [DESIGN_ROW],
      { rename: () => Promise.reject(new Error('Workspace segment "notes" is already taken')) },
      { onSwitch },
    )
    const url = screen.getByLabelText(/workspace url/i)
    fireEvent.change(url, { target: { value: 'notes' } })
    fireEvent.keyDown(url, { key: 'Enter' })

    expect((await screen.findByRole('alert')).textContent).toContain('already taken')
    expect(onSwitch).not.toHaveBeenCalled()
  })

  it('shows the name read-only where the keeper cannot rename', () => {
    // Not hidden: the name is the popover's HEAD and has to be stated either
    // way. `DocumentProperties` settles this the same way — `readOnly` when
    // there is no `onTitleChange` — because hiding the subject to express
    // "you cannot edit it" removes the subject.
    renderMenu([DESIGN_ROW, { workspaceId: NOTES, segment: 'notes', displayName: 'Notes' }])
    const field = screen.getByLabelText(/^workspace name$/i)
    expect(field).toHaveProperty('value', 'Design team')
    expect(field).toHaveProperty('readOnly', true)
    expect(screen.getByLabelText(/workspace url/i)).toHaveProperty('readOnly', true)
  })

  it('states nothing to edit until the rows say which workspace the address names', () => {
    renderMenu([], { rename: () => Promise.reject(new Error('not expected')) })
    expect(screen.queryByLabelText(/workspace name/i)).toBeNull()
  })
})
