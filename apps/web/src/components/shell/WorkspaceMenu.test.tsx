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
    fireEvent.change(screen.getByLabelText(/workspace name/i), { target: { value: 'Design' } })
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
    const input = screen.getByLabelText(/workspace name/i)
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
    fireEvent.change(screen.getByLabelText(/workspace name/i), { target: { value: 'Design' } })
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

describe('WorkspaceMenu — renaming', () => {
  const DESIGN_ROW: WorkspaceEntry = {
    workspaceId: DESIGN,
    segment: 'design',
    displayName: 'Design team',
  }

  function openRename() {
    fireEvent.click(screen.getByRole('menuitem', { name: /rename workspace/i }))
  }

  it('edits the URL the workspace lives at, with no word for the layer', () => {
    // ADR-0019 calls this layer the `segment`, which is not a word to put in
    // front of somebody, and any other word invents a FOURTH name for a
    // layer that has three. The field shows the URL it lands in instead.
    renderMenu([DESIGN_ROW], { rename: () => Promise.resolve(DESIGN_ROW) })
    openRename()
    expect(screen.getByText('/w/')).toBeTruthy()
    expect(screen.getByLabelText(/workspace url/i)).toHaveProperty('value', 'design')
    expect(screen.getByText(/links using the old url stop working/i)).toBeTruthy()
  })

  it('renames in place and reports the answered row, without leaving', async () => {
    // A display-name edit does not move the URL, so nothing navigates and
    // nothing remounts — the shell's copy of the row is the only thing that
    // can tell the popover head its subject has a new name.
    const onSwitch = vi.fn()
    const onRenamed = vi.fn()
    const renamed = { workspaceId: DESIGN, segment: 'design', displayName: 'Marketing' }
    renderMenu([DESIGN_ROW], { rename: () => Promise.resolve(renamed) }, { onSwitch, onRenamed })
    openRename()
    fireEvent.change(screen.getByLabelText(/^workspace name$/i), { target: { value: 'Marketing' } })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() => expect(onRenamed).toHaveBeenCalledWith(renamed))
    expect(onSwitch).not.toHaveBeenCalled()
  })

  it('follows the URL when a rename moves it', async () => {
    // The segment IS the address. Renaming it while the URL still says the
    // old one leaves the page addressing a workspace that no longer answers
    // to that handle.
    const onSwitch = vi.fn()
    renderMenu(
      [DESIGN_ROW],
      {
        rename: () =>
          Promise.resolve({
            workspaceId: DESIGN,
            segment: 'marketing',
            displayName: 'Design team',
          }),
      },
      { onSwitch },
    )
    openRename()
    fireEvent.change(screen.getByLabelText(/workspace url/i), { target: { value: 'marketing' } })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() => expect(onSwitch).toHaveBeenCalledWith('marketing'))
  })

  it('sends only the layers the form actually changed', async () => {
    // Absent means "leave this layer alone" in the port, and submitting the
    // unchanged URL back would turn every name edit into a segment write —
    // the one call that can fail on a collision, for no reason.
    const rename = vi.fn(() =>
      Promise.resolve({ workspaceId: DESIGN, segment: 'design', displayName: 'Renamed' }),
    )
    renderMenu([DESIGN_ROW], { rename })
    openRename()
    fireEvent.change(screen.getByLabelText(/^workspace name$/i), { target: { value: 'Renamed' } })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() => expect(rename).toHaveBeenCalled())
    expect(rename).toHaveBeenCalledWith(DESIGN, { displayName: 'Renamed' })
  })

  it('surfaces a taken URL in the form and stays put', async () => {
    const onSwitch = vi.fn()
    renderMenu(
      [DESIGN_ROW],
      { rename: () => Promise.reject(new Error('Workspace segment "notes" is already taken')) },
      { onSwitch },
    )
    openRename()
    fireEvent.change(screen.getByLabelText(/workspace url/i), { target: { value: 'notes' } })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

    expect((await screen.findByRole('alert')).textContent).toContain('already taken')
    expect(onSwitch).not.toHaveBeenCalled()
  })

  it('offers no rename when the keeper has no way to rename one', () => {
    renderMenu([DESIGN_ROW, { workspaceId: NOTES, segment: 'notes', displayName: 'Notes' }])
    expect(screen.getByRole('menuitem', { name: /notes/i })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: /rename workspace/i })).toBeNull()
  })

  it('offers no rename until the rows say which workspace the address names', () => {
    // Renaming needs the row: the form starts from the name and URL the
    // workspace HAS, and one pre-filled from a handle alone would offer to
    // overwrite a display name it never read.
    renderMenu([], { rename: () => Promise.reject(new Error('not expected')) })
    expect(screen.queryByRole('menuitem', { name: /rename workspace/i })).toBeNull()
  })
})
