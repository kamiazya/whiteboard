/**
 * The name and address fields, rendered on their own: the switcher menu and
 * the server-mode shell both mount them, so what they decide NOT to write is
 * pinned here rather than through either host.
 */
import {
  WORKSPACE_DISPLAY_NAME_MAX_LENGTH,
  WORKSPACE_SEGMENT_MAX_LENGTH,
} from '@kamiazya/whiteboard-model'
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
  notice,
  sessionLabel,
}: {
  active?: WorkspaceRow
  rename?: Rename
  current?: string | null
  onSwitch?: (handle: string) => void
  onRenamed?: (entry: WorkspaceEntry) => void
  notice?: string | null
  sessionLabel?: string | null
} = {}) {
  const fields = (row: WorkspaceRow) => (
    <WorkspaceIdentityFields
      active={row}
      current={current}
      rename={rename}
      onRenamed={onRenamed}
      onSwitch={onSwitch}
      notice={notice}
      sessionLabel={sessionLabel}
    />
  )
  const view = render(fields(active))
  return {
    name: screen.getByLabelText(/^workspace name$/i) as HTMLInputElement,
    url: screen.getByLabelText(/workspace url/i) as HTMLInputElement,
    /** What the host does once a rename has answered: restate the row. */
    rerender: (row: WorkspaceRow) => view.rerender(fields(row)),
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

describe('WorkspaceIdentityFields — Escape after an edit', () => {
  it('puts back the name the edit started from, and leaves the field', async () => {
    const rename = applyingRename()
    const { name } = renderFields({ rename })
    name.focus()
    fireEvent.change(name, { target: { value: 'Oops' } })
    await waitFor(() => expect(rename).toHaveBeenCalledWith(DESIGN, { displayName: 'Oops' }))
    fireEvent.keyDown(name, { key: 'Escape' })
    await waitFor(() =>
      expect(rename).toHaveBeenLastCalledWith(DESIGN, { displayName: 'Design team' }),
    )
    expect(document.activeElement).not.toBe(name)
  })

  // Every keystroke is already committed, so the first session's rename is
  // the stored name by the time the second begins; reverting to the name the
  // field MOUNTED with would undo it.
  it('in a later editing session reverts to the name that session began from', async () => {
    const rename = applyingRename()
    const { name, rerender } = renderFields({ rename })
    fireEvent.focus(name)
    fireEvent.change(name, { target: { value: 'Marketing' } })
    fireEvent.blur(name)
    rerender({ ...DESIGN_ROW, displayName: 'Marketing' })
    fireEvent.focus(name)
    fireEvent.change(name, { target: { value: 'Mx' } })
    await waitFor(() => expect(rename).toHaveBeenCalledWith(DESIGN, { displayName: 'Mx' }))
    rename.mockClear()
    fireEvent.keyDown(name, { key: 'Escape' })
    await waitFor(() =>
      expect(rename).toHaveBeenCalledExactlyOnceWith(DESIGN, { displayName: 'Marketing' }),
    )
  })
})

describe('WorkspaceIdentityFields — the URL field', () => {
  it('discards a draft on Escape, and writes nothing when the field is then left', async () => {
    const rename = applyingRename()
    const { url } = renderFields({ rename })
    fireEvent.change(url, { target: { value: 'gone' } })
    fireEvent.keyDown(url, { key: 'Escape' })
    expect(url.value).toBe('design')
    fireEvent.blur(url)
    await Promise.resolve()
    expect(rename).not.toHaveBeenCalled()
  })

  it('writes the trimmed URL when the field is left', async () => {
    const rename = applyingRename()
    const { url } = renderFields({ rename })
    fireEvent.change(url, { target: { value: ' marketing ' } })
    fireEvent.blur(url)
    await waitFor(() =>
      expect(rename).toHaveBeenCalledExactlyOnceWith(DESIGN, { segment: 'marketing' }),
    )
  })

  it('does not commit on the Enter that confirms an IME conversion', async () => {
    const rename = applyingRename()
    const { url } = renderFields({ rename })
    fireEvent.change(url, { target: { value: 'marketing' } })
    fireEvent.keyDown(url, { key: 'Enter', isComposing: true, keyCode: 229 })
    await Promise.resolve()
    expect(rename).not.toHaveBeenCalled()
  })

  it('warns that old links stop working only while the draft differs from the URL', () => {
    const { url } = renderFields({ rename: applyingRename() })
    expect(screen.queryByText(/old URL stop working/)).toBeNull()
    fireEvent.change(url, { target: { value: 'design ' } })
    expect(url.value).toBe('design ')
    expect(screen.queryByText(/old URL stop working/)).toBeNull()
    fireEvent.change(url, { target: { value: 'marketing' } })
    expect(screen.getByText(/old URL stop working/)).toBeTruthy()
  })
})

// The fields sit inside a popover and a shell that bind single-key shortcuts;
// a letter typed into a name must stay a letter.
describe('WorkspaceIdentityFields — keystrokes stay in the field', () => {
  it('lets no keydown in either field reach a listener above it', () => {
    const { name, url } = renderFields({ rename: applyingRename() })
    const above = vi.fn()
    document.addEventListener('keydown', above)
    try {
      fireEvent.keyDown(name, { key: 'a' })
      fireEvent.keyDown(url, { key: 'a' })
    } finally {
      document.removeEventListener('keydown', above)
    }
    expect(above).not.toHaveBeenCalled()
  })
})

describe('WorkspaceIdentityFields — what the host passes in', () => {
  it("shows the host's notice where a refusal is shown, and the session word", () => {
    renderFields({
      rename: applyingRename(),
      notice: 'Could not switch.',
      sessionLabel: 'Signed in',
    })
    expect(screen.getByRole('alert').textContent).toBe('Could not switch.')
    expect(screen.getByText('Signed in')).toBeTruthy()
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

// The browser keeper used to store whatever these fields sent, and its own
// reader then refused the row. The fields check against the model first, so a
// refusal is said beside the field rather than discovered as an empty list.
describe('WorkspaceIdentityFields — a value the model refuses', () => {
  it('says why an address is refused, and writes nothing', async () => {
    const rename = applyingRename()
    const { url } = renderFields({ rename })
    fireEvent.change(url, { target: { value: 'my team' } })
    fireEvent.keyDown(url, { key: 'Enter' })
    expect((await screen.findByRole('alert')).textContent).toMatch(/workspace segment/i)
    expect(rename).not.toHaveBeenCalled()
  })

  it('clears a refusal once a later write is accepted', async () => {
    const { name, url } = renderFields({ rename: applyingRename() })
    fireEvent.change(url, { target: { value: 'my team' } })
    fireEvent.keyDown(url, { key: 'Enter' })
    expect(await screen.findByRole('alert')).toBeTruthy()
    fireEvent.change(name, { target: { value: 'Marketing' } })
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })

  it('caps both fields at the length the model accepts', () => {
    const { name, url } = renderFields({ rename: applyingRename() })
    expect(name.maxLength).toBe(WORKSPACE_DISPLAY_NAME_MAX_LENGTH)
    expect(url.maxLength).toBe(WORKSPACE_SEGMENT_MAX_LENGTH)
  })

  it('reads a long name pasted past the cap as refused rather than writing it', async () => {
    const rename = applyingRename()
    const { name } = renderFields({ rename })
    fireEvent.change(name, { target: { value: 'n'.repeat(WORKSPACE_DISPLAY_NAME_MAX_LENGTH + 1) } })
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(rename).not.toHaveBeenCalled()
  })
})
