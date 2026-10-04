/**
 * The name and address fields, rendered on their own: the switcher menu and
 * the server-mode shell both mount them, so what they decide NOT to write is
 * pinned here rather than through either host.
 */
import type { RenameWorkspaceInput, WorkspaceEntry } from '@kamiazya/whiteboard-ports'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceRow } from '../../lib/workspace-switcher-source.js'
import { WorkspaceIdentityFields } from './WorkspaceIdentityFields.js'

const DESIGN = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const DESIGN_ROW: WorkspaceRow = {
  workspaceId: DESIGN,
  segment: 'design',
  displayName: 'Design team',
}

type Rename = (
  id: string,
  input: Omit<RenameWorkspaceInput, 'workspaceId'>,
) => Promise<WorkspaceEntry>

/** A rename that answers with the row the edit would produce. */
function applyingRename(base: WorkspaceRow = DESIGN_ROW) {
  return vi.fn<Rename>((_id, input) => Promise.resolve({ ...base, ...input }))
}

function renderFields({
  active = DESIGN_ROW,
  rename,
  current = 'design',
  onSwitch = vi.fn(),
  onRenamed = vi.fn(),
}: {
  active?: WorkspaceRow
  rename?: Rename
  current?: string | null
  onSwitch?: (handle: string) => void
  onRenamed?: (entry: WorkspaceEntry) => void
} = {}) {
  render(
    <WorkspaceIdentityFields
      active={active}
      current={current}
      rename={rename}
      onRenamed={onRenamed}
      onSwitch={onSwitch}
    />,
  )
  return {
    name: screen.getByLabelText(/^workspace name$/i),
    url: screen.getByLabelText(/workspace url/i),
  }
}

afterEach(cleanup)

describe('WorkspaceIdentityFields — navigating after a rename', () => {
  it('does not navigate when a name edit left the segment where it was', async () => {
    const onSwitch = vi.fn()
    const onRenamed = vi.fn()
    const { name } = renderFields({ rename: applyingRename(), onSwitch, onRenamed })
    fireEvent.change(name, { target: { value: 'Marketing' } })
    await waitFor(() => expect(onRenamed).toHaveBeenCalledTimes(1))
    expect(onSwitch).not.toHaveBeenCalled()
  })

  it('navigates to the segment the rename answered with when the address moved', async () => {
    const onSwitch = vi.fn()
    const onRenamed = vi.fn()
    const { url } = renderFields({ rename: applyingRename(), onSwitch, onRenamed })
    fireEvent.change(url, { target: { value: 'marketing' } })
    fireEvent.keyDown(url, { key: 'Enter' })
    await waitFor(() => expect(onSwitch).toHaveBeenCalledWith('marketing'))
    expect(onRenamed).toHaveBeenCalledTimes(1)
  })
})

describe('WorkspaceIdentityFields — writes nothing for an edit that changes nothing', () => {
  it('writes nothing for an emptied name, a blank one, or the name it already has', async () => {
    const rename = applyingRename()
    const { name } = renderFields({ rename })
    fireEvent.change(name, { target: { value: '' } })
    fireEvent.change(name, { target: { value: '   ' } })
    fireEvent.change(name, { target: { value: 'Design team' } })
    fireEvent.change(name, { target: { value: ' Design team ' } })
    await Promise.resolve()
    expect(rename).not.toHaveBeenCalled()
  })

  it('writes the trimmed name when the edit does change it', async () => {
    const rename = applyingRename()
    const { name } = renderFields({ rename })
    fireEvent.change(name, { target: { value: ' Marketing ' } })
    await waitFor(() => expect(rename).toHaveBeenCalledWith(DESIGN, { displayName: 'Marketing' }))
  })

  it('writes nothing for a URL left as it was, and nothing for an emptied one', async () => {
    const rename = applyingRename()
    const { url } = renderFields({ rename })
    fireEvent.change(url, { target: { value: 'design' } })
    fireEvent.keyDown(url, { key: 'Enter' })
    fireEvent.change(url, { target: { value: '  ' } })
    fireEvent.blur(url)
    await Promise.resolve()
    expect(rename).not.toHaveBeenCalled()
  })
})

describe('WorkspaceIdentityFields — Escape', () => {
  it('on a name field nobody edited writes nothing', async () => {
    const rename = applyingRename()
    const { name } = renderFields({ rename })
    fireEvent.focus(name)
    fireEvent.keyDown(name, { key: 'Escape' })
    await Promise.resolve()
    expect(rename).not.toHaveBeenCalled()
  })

  it('on an unnamed workspace does not write a blank name back', async () => {
    const unnamed: WorkspaceRow = { workspaceId: DESIGN, segment: 'design' }
    const rename = applyingRename(unnamed)
    const { name } = renderFields({ active: unnamed, rename })
    fireEvent.focus(name)
    fireEvent.change(name, { target: { value: 'Draft' } })
    await waitFor(() => expect(rename).toHaveBeenCalledWith(DESIGN, { displayName: 'Draft' }))
    rename.mockClear()
    fireEvent.keyDown(name, { key: 'Escape' })
    await Promise.resolve()
    expect(rename).not.toHaveBeenCalled()
  })
})

describe('WorkspaceIdentityFields — where the keeper cannot rename', () => {
  it('takes no typing and no Escape write, and shows the stored values', () => {
    const onRenamed = vi.fn()
    const { name, url } = renderFields({ onRenamed })
    fireEvent.change(name, { target: { value: 'Typed' } })
    fireEvent.change(url, { target: { value: 'typed' } })
    fireEvent.keyDown(name, { key: 'Escape' })
    expect(name).toHaveProperty('value', 'Design team')
    expect(url).toHaveProperty('value', 'design')
    expect(onRenamed).not.toHaveBeenCalled()
  })
})
