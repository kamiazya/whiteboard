import type { WorkspaceEntry } from '@kamiazya/whiteboard-ports'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

function listOnly(workspaces: WorkspaceEntry[]): WorkspaceSwitcherSource {
  return { list: () => Promise.resolve(workspaces) }
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

  it('creates once when Create is pressed twice before the first settles', async () => {
    // `busy` is a React state SNAPSHOT: the closure that ran the first press
    // still sees `busy === false`. The button's `disabled` covers a second
    // CLICK — React flushes discrete events synchronously — but this form
    // also submits on Enter, and the input carries no disabled attribute, so
    // the keyboard path has no such flush between two presses.
    //
    // Each browser create mints and persists a workspace, so a second one is
    // a workspace nobody asked for, holding a segment that shifts the next
    // real one to `-2`.
    let settle: ((w: WorkspaceEntry) => void) | undefined
    const create = vi.fn(
      () =>
        new Promise<WorkspaceEntry>((resolve) => {
          settle = resolve
        }),
    )
    render(
      <WorkspaceSwitcher
        current="design"
        source={source([{ workspaceId: DESIGN, segment: 'design' }], create)}
        onSwitch={vi.fn()}
      />,
    )
    open()
    fireEvent.click(await screen.findByRole('button', { name: /new workspace/i }))
    const input = await screen.findByLabelText(/workspace name/i)
    fireEvent.change(input, { target: { value: 'Design' } })

    // Dispatched RAW inside one act, not through two `fireEvent` calls:
    // fireEvent flushes between them, so the second already sees the state
    // update and the case never arrives. Measured — through fireEvent this
    // passes with no guard at all, which is how a test for this can look
    // green while pinning nothing.
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })

    expect(create).toHaveBeenCalledTimes(1)
    settle?.({ workspaceId: NOTES, segment: 'design-2', displayName: 'Design' })
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
  it('offers no creation when the keeper has no way to create one', async () => {
    // DESIGN.md's standing rule: never offer what the keeper cannot honour.
    // The daemon has no create surface yet — only `GET /api/workspaces` —
    // so a button there would be a promise the app cannot keep. Absent, not
    // disabled: a disabled control says "not right now", and this is "not
    // here".
    render(
      <WorkspaceSwitcher
        current="design"
        source={listOnly([
          { workspaceId: DESIGN, segment: 'design', displayName: 'Design team' },
          { workspaceId: NOTES, segment: 'notes', displayName: 'Notes' },
        ])}
        onSwitch={vi.fn()}
      />,
    )
    open()
    // The subject is PRESENT — the menu really rendered — so the absence
    // below is a decision this control made and not a popover that never
    // opened.
    expect(await screen.findByRole('menuitem', { name: /notes/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /new workspace/i })).toBeNull()
  })

  it('renames the workspace in place, without leaving it', async () => {
    // A display-name edit does not move the address, so nothing navigates
    // and nothing remounts — which is exactly why the trigger has to be
    // re-read from what rename ANSWERED. Re-listing would work too; taking
    // the answer is why the port returns one.
    const onSwitch = vi.fn()
    const rename = vi.fn(() =>
      Promise.resolve({ workspaceId: DESIGN, segment: 'design', displayName: 'Marketing' }),
    )
    render(
      <WorkspaceSwitcher
        current="design"
        source={{
          ...listOnly([{ workspaceId: DESIGN, segment: 'design', displayName: 'Design team' }]),
          rename,
        }}
        onSwitch={onSwitch}
      />,
    )
    open()
    fireEvent.click(await screen.findByRole('button', { name: /rename workspace/i }))
    fireEvent.change(screen.getByLabelText(/^workspace name$/i), {
      target: { value: 'Marketing' },
    })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() =>
      expect(screen.getByTestId('workspace-switcher-trigger').textContent).toContain('Marketing'),
    )
    expect(rename).toHaveBeenCalledWith(DESIGN, { displayName: 'Marketing' })
    expect(onSwitch).not.toHaveBeenCalled()
  })

  it('follows the address when a rename moves it', async () => {
    // The segment IS the address. Renaming it while the URL still says the
    // old one leaves the page addressing a workspace that no longer answers
    // to that handle, so the switcher moves the address to what rename
    // answered with.
    const onSwitch = vi.fn()
    render(
      <WorkspaceSwitcher
        current="design"
        source={{
          ...listOnly([{ workspaceId: DESIGN, segment: 'design', displayName: 'Design team' }]),
          rename: () =>
            Promise.resolve({
              workspaceId: DESIGN,
              segment: 'marketing',
              displayName: 'Design team',
            }),
        }}
        onSwitch={onSwitch}
      />,
    )
    open()
    fireEvent.click(await screen.findByRole('button', { name: /rename workspace/i }))
    fireEvent.change(screen.getByLabelText(/workspace address/i), {
      target: { value: 'marketing' },
    })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() => expect(onSwitch).toHaveBeenCalledWith('marketing'))
  })

  it('sends only the layers the form actually changed', async () => {
    // Absent means "leave this layer alone" in the port, and submitting the
    // unchanged address back would turn every name edit into an address
    // write — the one call that can fail on a collision, for no reason.
    const rename = vi.fn(() =>
      Promise.resolve({ workspaceId: DESIGN, segment: 'design', displayName: 'Renamed' }),
    )
    render(
      <WorkspaceSwitcher
        current="design"
        source={{
          ...listOnly([{ workspaceId: DESIGN, segment: 'design', displayName: 'Design team' }]),
          rename,
        }}
        onSwitch={vi.fn()}
      />,
    )
    open()
    fireEvent.click(await screen.findByRole('button', { name: /rename workspace/i }))
    fireEvent.change(screen.getByLabelText(/^workspace name$/i), { target: { value: 'Renamed' } })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() => expect(rename).toHaveBeenCalled())
    expect(rename).toHaveBeenCalledWith(DESIGN, { displayName: 'Renamed' })
  })

  it('surfaces a taken address in the form and stays put', async () => {
    const onSwitch = vi.fn()
    render(
      <WorkspaceSwitcher
        current="design"
        source={{
          ...listOnly([{ workspaceId: DESIGN, segment: 'design', displayName: 'Design team' }]),
          rename: () => Promise.reject(new Error('Workspace segment "notes" is already taken')),
        }}
        onSwitch={onSwitch}
      />,
    )
    open()
    fireEvent.click(await screen.findByRole('button', { name: /rename workspace/i }))
    fireEvent.change(screen.getByLabelText(/workspace address/i), { target: { value: 'notes' } })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

    expect((await screen.findByRole('alert')).textContent).toContain('already taken')
    expect(onSwitch).not.toHaveBeenCalled()
    // The address the page carries is unchanged, so the subject still reads
    // as the workspace it is.
    expect(screen.getByTestId('workspace-switcher-trigger').textContent).toContain('Design team')
  })

  it('offers no rename when the keeper has no way to rename one', async () => {
    // Same standing rule as creation: never offer what the keeper cannot
    // honour. The daemon has no rename route yet.
    render(
      <WorkspaceSwitcher
        current="design"
        source={listOnly([
          { workspaceId: DESIGN, segment: 'design', displayName: 'Design team' },
          { workspaceId: NOTES, segment: 'notes', displayName: 'Notes' },
        ])}
        onSwitch={vi.fn()}
      />,
    )
    open()
    // The subject is PRESENT before the absence below is claimed.
    expect(await screen.findByRole('menuitem', { name: /notes/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /rename workspace/i })).toBeNull()
  })

  it('offers no rename until the list says which workspace the address names', async () => {
    // Renaming needs the row: the form starts from the name and address the
    // workspace HAS, and a form pre-filled from a handle alone would offer
    // to overwrite a display name it never read.
    render(
      <WorkspaceSwitcher
        current="design"
        source={{ list: () => new Promise(() => {}), rename: () => Promise.reject(new Error()) }}
        onSwitch={vi.fn()}
      />,
    )
    open()
    expect(screen.queryByRole('button', { name: /rename workspace/i })).toBeNull()
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
