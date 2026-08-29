import type { WorkspaceEntry } from '@kamiazya/whiteboard-ports'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceSwitcher, type WorkspaceSwitcherSource } from './WorkspaceSwitcher.js'

const DESIGN = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const NOTES = '01BX5ZZKBKACTAV9WEVGEMMVRZ'

function source(
  workspaces: WorkspaceEntry[],
  create?: WorkspaceSwitcherSource['create'],
): WorkspaceSwitcherSource {
  return {
    list: () => Promise.resolve(workspaces),
    create: create ?? (() => Promise.reject(new Error('not expected'))),
  }
}

function open() {
  fireEvent.click(screen.getByTestId('workspace-switcher-trigger'))
}

afterEach(cleanup)

describe('WorkspaceSwitcher', () => {
  it('names the current workspace by its display name, not by the handle in the address', async () => {
    // The shell's subject. The address carries `design`; a person named this
    // workspace something else, and the chrome shows what they chose.
    render(
      <WorkspaceSwitcher
        current="design"
        source={source([{ workspaceId: DESIGN, segment: 'design', displayName: 'Design team' }])}
        onSwitch={vi.fn()}
      />,
    )
    expect((await screen.findByTestId('workspace-switcher-trigger')).textContent).toContain(
      'Design team',
    )
  })

  it('switches by the target workspace HANDLE, never by its label', async () => {
    // A display name is free text with no uniqueness duty and no charset
    // rule — it cannot address anything. The handle is the segment when
    // there is one, so this asserts the layer, not the string.
    const onSwitch = vi.fn()
    render(
      <WorkspaceSwitcher
        current="design"
        source={source([
          { workspaceId: DESIGN, segment: 'design', displayName: 'Design team' },
          { workspaceId: NOTES, segment: 'notes', displayName: 'Notes & ideas' },
        ])}
        onSwitch={onSwitch}
      />,
    )
    open()
    fireEvent.click(await screen.findByRole('menuitem', { name: /notes & ideas/i }))
    expect(onSwitch).toHaveBeenCalledWith('notes')
  })

  it('addresses a workspace with no segment by its canonical id', async () => {
    // The id form is not a lesser answer (ADR-0019) — it is what an unnamed
    // workspace is addressed by, and the switcher must be able to reach one.
    const onSwitch = vi.fn()
    render(
      <WorkspaceSwitcher
        current="design"
        source={source([
          { workspaceId: DESIGN, segment: 'design' },
          { workspaceId: NOTES, displayName: 'Unnamed' },
        ])}
        onSwitch={onSwitch}
      />,
    )
    open()
    fireEvent.click(await screen.findByRole('menuitem', { name: /unnamed/i }))
    expect(onSwitch).toHaveBeenCalledWith(NOTES)
  })

  it('marks the current workspace and does not re-switch to it', async () => {
    const onSwitch = vi.fn()
    render(
      <WorkspaceSwitcher
        current="design"
        source={source([{ workspaceId: DESIGN, segment: 'design', displayName: 'Design team' }])}
        onSwitch={onSwitch}
      />,
    )
    open()
    const item = await screen.findByRole('menuitem', { name: /design team/i })
    expect(item.getAttribute('aria-current')).toBe('true')
    fireEvent.click(item)
    expect(onSwitch).not.toHaveBeenCalled()
  })

  it('offers creation even with a single workspace, since that is the only way to a second', async () => {
    // The daemon list control hid itself below two workspaces. That is right
    // for a filter and wrong for the only door out of one workspace.
    render(
      <WorkspaceSwitcher
        current="default"
        source={source([{ workspaceId: DESIGN, segment: 'default' }])}
        onSwitch={vi.fn()}
      />,
    )
    open()
    expect(await screen.findByRole('button', { name: /new workspace/i })).toBeTruthy()
  })

  it('switches to the handle CREATE answered with, not to the name that was typed', async () => {
    // The typed name is a display name; the segment is derived from it and
    // may be suffixed past a collision or absent entirely. Navigating to what
    // was typed addresses a workspace that does not exist.
    const onSwitch = vi.fn()
    const create = vi.fn(
      async (displayName: string): Promise<WorkspaceEntry> => ({
        workspaceId: NOTES,
        segment: 'design-2',
        displayName,
      }),
    )
    render(
      <WorkspaceSwitcher
        current="design"
        source={source([{ workspaceId: DESIGN, segment: 'design' }], create)}
        onSwitch={onSwitch}
      />,
    )
    open()
    fireEvent.click(await screen.findByRole('button', { name: /new workspace/i }))
    fireEvent.change(await screen.findByLabelText(/workspace name/i), {
      target: { value: 'Design' },
    })
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }))
    await waitFor(() => expect(onSwitch).toHaveBeenCalledWith('design-2'))
    expect(create).toHaveBeenCalledWith('Design')
  })

  it('surfaces a create failure in the form and stays put', async () => {
    // Navigating away from a workspace that was not created would land on a
    // fallback and read as success.
    const onSwitch = vi.fn()
    render(
      <WorkspaceSwitcher
        current="design"
        source={source([{ workspaceId: DESIGN, segment: 'design' }], () =>
          Promise.reject(new Error('that name is taken')),
        )}
        onSwitch={onSwitch}
      />,
    )
    open()
    fireEvent.click(await screen.findByRole('button', { name: /new workspace/i }))
    fireEvent.change(await screen.findByLabelText(/workspace name/i), {
      target: { value: 'Design' },
    })
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }))
    expect((await screen.findByRole('alert')).textContent).toContain('that name is taken')
    expect(onSwitch).not.toHaveBeenCalled()
  })

  it('falls back to the address handle while the list has not answered', async () => {
    // The list is IndexedDB or HTTP; the address is already known. Rendering
    // nothing until the list lands would flash an empty subject on every
    // page load, and the handle is a true statement about where we are.
    render(
      <WorkspaceSwitcher
        current="design"
        source={{ list: () => new Promise(() => {}), create: () => Promise.reject(new Error()) }}
        onSwitch={vi.fn()}
      />,
    )
    expect(screen.getByTestId('workspace-switcher-trigger').textContent).toContain('design')
  })
  it('renders nothing while the address has not resolved a workspace', () => {
    // A subject the shell cannot name is not one to invent a placeholder
    // for. Asserting the trigger is ABSENT is only meaningful because the
    // case above proves the same render produces one when `current` is set.
    render(
      <WorkspaceSwitcher
        current={null}
        source={source([{ workspaceId: DESIGN, segment: 'design' }])}
        onSwitch={vi.fn()}
      />,
    )
    expect(screen.queryByTestId('workspace-switcher-trigger')).toBeNull()
  })
})
