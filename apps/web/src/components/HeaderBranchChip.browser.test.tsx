import type { BranchMeta } from '@kamiazya/whiteboard-mcp/api-contracts'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import type { UseBranchesResult } from '@/hooks/useBranches'

// Real pointer/keyboard interaction with the Radix dropdown/dialog/alert-dialog
// stack, which the jsdom-based HeaderBranchChip.test.tsx deliberately skips.

const branches: BranchMeta[] = [
  { name: 'main', tipFrontiers: '', color: '#1971c2', createdAt: '2026-04-23T00:00:00Z' },
  { name: 'feature-x', tipFrontiers: '', color: '#9333ea', createdAt: '2026-04-23T01:00:00Z' },
]

function makeState(): UseBranchesResult {
  return {
    state: { head: 'main', branches },
    loading: false,
    error: null,
    refetch: vi.fn().mockResolvedValue(undefined),
    createBranch: vi.fn().mockResolvedValue(branches[0]),
    deleteBranch: vi.fn().mockResolvedValue(undefined),
    getBranchStats: vi.fn().mockResolvedValue({ unmergedCommits: 2, isHead: false }),
    renameBranch: vi.fn().mockResolvedValue(branches[0]),
    setHead: vi.fn().mockResolvedValue({ head: 'feature-x' }),
    merge: vi.fn(),
  }
}

const stateHolder: { current: UseBranchesResult } = { current: makeState() }

vi.mock('@/hooks/useBranches', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/useBranches')>('@/hooks/useBranches')
  return {
    ...actual,
    useBranches: () => stateHolder.current,
  }
})

import { HeaderBranchChip } from './HeaderBranchChip.js'

beforeEach(() => {
  // MergeDialog's thumbnail-fallback effect calls apiFetch(.../versions); return
  // an empty (but schema-valid) list so it resolves without a preview image.
  const fetchMock = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify({ versions: [] }), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  stateHolder.current = makeState()
})

describe('HeaderBranchChip (real Radix dropdown/dialog)', () => {
  it('selecting another branch from the dropdown calls setHead', async () => {
    render(<HeaderBranchChip workspaceId="s1" path="c1" />)
    const chip = screen.getByTestId('header-branch-chip')
    await userEvent.click(chip)

    const option = await screen.findByText('feature-x')
    await userEvent.click(option)

    expect(stateHolder.current.setHead).toHaveBeenCalledWith('feature-x')
  })

  it('the preview control on a non-HEAD row previews without switching (ADR-0022)', async () => {
    const onPreviewVariation = vi.fn()
    render(<HeaderBranchChip workspaceId="s1" path="c1" onPreviewVariation={onPreviewVariation} />)
    await userEvent.click(screen.getByTestId('header-branch-chip'))

    const previewButton = await screen.findByTestId('branch-preview-feature-x')
    await userEvent.click(previewButton)

    expect(onPreviewVariation).toHaveBeenCalledWith('feature-x')
    // Looking is not switching: the shared act must not ride along.
    expect(stateHolder.current.setHead).not.toHaveBeenCalled()
  })

  it('offers no preview control for the HEAD row, and none at all without the callback', async () => {
    render(<HeaderBranchChip workspaceId="s1" path="c1" onPreviewVariation={vi.fn()} />)
    await userEvent.click(screen.getByTestId('header-branch-chip'))
    await screen.findByText('feature-x')
    expect(screen.queryByTestId('branch-preview-main')).toBeNull()
    cleanup()

    render(<HeaderBranchChip workspaceId="s1" path="c1" />)
    await userEvent.click(screen.getByTestId('header-branch-chip'))
    await screen.findByText('feature-x')
    expect(screen.queryByTestId('branch-preview-feature-x')).toBeNull()
  })

  it('kebab -> rename -> Enter calls renameBranch with the old and new names', async () => {
    // Rename is disabled while head === 'main', so switch HEAD first.
    stateHolder.current.state = { head: 'feature-x', branches }
    render(<HeaderBranchChip workspaceId="s1" path="c1" />)
    const kebab = screen.getByTestId('header-branch-kebab')
    await userEvent.click(kebab)

    const renameItem = await screen.findByText(/Rename/)
    await userEvent.click(renameItem)

    const input = await screen.findByPlaceholderText('feature-x')
    await userEvent.clear(input)
    await userEvent.type(input, 'renamed-branch{Enter}')

    expect(stateHolder.current.renameBranch).toHaveBeenCalledWith('feature-x', 'renamed-branch')
  })

  it('kebab -> delete -> confirm shows the unmerged-commits warning and calls deleteBranch', async () => {
    stateHolder.current.state = { head: 'feature-x', branches }
    render(<HeaderBranchChip workspaceId="s1" path="c1" />)
    const kebab = screen.getByTestId('header-branch-kebab')
    await userEvent.click(kebab)

    const deleteItem = await screen.findByText(/Delete/)
    await userEvent.click(deleteItem)

    await screen.findByText(/changes not yet combined remain/)

    const confirmButton = await screen.findByRole('button', { name: 'Delete' })
    await userEvent.click(confirmButton)

    expect(stateHolder.current.deleteBranch).toHaveBeenCalledWith('feature-x')
  })

  // State that names a VARIATION must not outlive the document it belongs to.
  // The chip stays mounted across a document switch (no key; `path` is a prop)
  // and holds `pendingDelete` as a captured BranchMeta, while `useBranches`
  // rebinds to the new document — so confirming addresses the departed
  // document's variation name at the one now on screen. Names collide freely:
  // every document has `main`, and a working name like `draft` repeats.
  //
  // `VersionTimeline`, rendered from the same top bar, already keeps this rule
  // and says why in its own comment ("confirming a dialog opened on the
  // previous canvas would POST that version id to the NEW canvas"). This chip
  // was the one that did not.
  it('a delete dialog left open across a document switch deletes nothing on the new document', async () => {
    stateHolder.current.state = { head: 'feature-x', branches }
    const { rerender } = render(<HeaderBranchChip workspaceId="s1" path="c1" />)
    await userEvent.click(screen.getByTestId('header-branch-kebab'))
    await userEvent.click(await screen.findByText(/Delete/))
    await screen.findByText(/Delete «feature-x»\?/)

    // The switch. `useBranches(workspaceId, path)` rebinds, so every verb the
    // chip can still reach now points at the second document.
    const second = makeState()
    second.state = { head: 'feature-x', branches }
    stateHolder.current = second
    rerender(<HeaderBranchChip workspaceId="s1" path="c2" />)

    // The dialog going away is the invariant, not a refused click: with no
    // confirm to press, the misaddressed delete is unreachable rather than
    // merely declined. Asserting on the button instead is also flaky — during
    // Radix's exit animation it is present, disabled and moving, and a click
    // on it hangs until the test times out (measured: 59s).
    await waitFor(() =>
      expect(
        screen.queryByText(/Delete «feature-x»\?/),
        'the dialog still stages a delete for the departed document, and confirming would address the one now on screen',
      ).toBeNull(),
    )
    expect(second.deleteBranch).not.toHaveBeenCalled()
  })

  it('inline "New variation…" form submits createBranch with the typed name', async () => {
    render(<HeaderBranchChip workspaceId="s1" path="c1" />)
    const chip = screen.getByTestId('header-branch-chip')
    await userEvent.click(chip)

    const newBranchItem = await screen.findByText(/New variation/)
    await userEvent.click(newBranchItem)

    const input = await screen.findByPlaceholderText('New variation name')
    await userEvent.type(input, 'my-new-branch{Enter}')

    expect(stateHolder.current.createBranch).toHaveBeenCalledWith({ name: 'my-new-branch' })
  })

  it('surfaces createBranch rejection as a role=alert with the safe error copy', async () => {
    stateHolder.current.createBranch = vi.fn().mockRejectedValue(new Error('boom'))
    render(<HeaderBranchChip workspaceId="s1" path="c1" />)
    const chip = screen.getByTestId('header-branch-chip')
    await userEvent.click(chip)

    const newBranchItem = await screen.findByText(/New variation/)
    await userEvent.click(newBranchItem)

    const input = await screen.findByPlaceholderText('New variation name')
    await userEvent.type(input, 'my-new-branch{Enter}')

    // The dropdown stays open on error so the user can retry; the error must
    // render inside the still-open dropdown content, not behind Radix's
    // aria-hidden'd background wrapper — a plain (non-hidden) query proves
    // it is actually visible/announced.
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Failed to create variation')
  })

  it("shows the daemon's own conflict reason, not the generic fallback", async () => {
    // The branch routes carry the human-readable reason in the
    // {error, message} body; the shared error reader forwards it. Before
    // that fold this banner showed only "Failed to create variation" and
    // the server\'s actual reason was discarded.
    stateHolder.current.createBranch = vi.fn().mockRejectedValue({
      status: 409,
      body: { error: 'branch_conflict', message: 'A variation named "main" already exists' },
    })
    render(<HeaderBranchChip workspaceId="s1" path="c1" />)
    await userEvent.click(screen.getByTestId('header-branch-chip'))
    await userEvent.click(await screen.findByText(/New variation/))
    const input = await screen.findByPlaceholderText('New variation name')
    await userEvent.type(input, 'main{Enter}')

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('A variation named "main" already exists')
    expect(alert.textContent).not.toContain('Failed to create variation')
  })

  it('surfaces setHead rejection as a role=alert with the safe error copy', async () => {
    stateHolder.current.setHead = vi.fn().mockRejectedValue(new Error('boom'))
    render(<HeaderBranchChip workspaceId="s1" path="c1" />)
    const chip = screen.getByTestId('header-branch-chip')
    await userEvent.click(chip)

    const option = await screen.findByText('feature-x')
    await userEvent.click(option)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Failed to switch variation')
  })

  it('surfaces renameBranch rejection as a role=alert with the safe error copy', async () => {
    stateHolder.current.state = { head: 'feature-x', branches }
    stateHolder.current.renameBranch = vi.fn().mockRejectedValue(new Error('boom'))
    render(<HeaderBranchChip workspaceId="s1" path="c1" />)
    const kebab = screen.getByTestId('header-branch-kebab')
    await userEvent.click(kebab)

    const renameItem = await screen.findByText(/Rename/)
    await userEvent.click(renameItem)

    const input = await screen.findByPlaceholderText('feature-x')
    await userEvent.clear(input)
    await userEvent.type(input, 'renamed-branch{Enter}')

    // The rename dialog stays open on error; the error must render inside the
    // still-open dialog content, so a plain (non-hidden) query must find it.
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Failed to rename variation')
  })

  it('surfaces deleteBranch rejection as a role=alert with the safe error copy', async () => {
    stateHolder.current.state = { head: 'feature-x', branches }
    stateHolder.current.deleteBranch = vi.fn().mockRejectedValue(new Error('boom'))
    render(<HeaderBranchChip workspaceId="s1" path="c1" />)
    const kebab = screen.getByTestId('header-branch-kebab')
    await userEvent.click(kebab)

    const deleteItem = await screen.findByText(/Delete/)
    await userEvent.click(deleteItem)

    const confirmButton = await screen.findByRole('button', { name: 'Delete' })
    await userEvent.click(confirmButton)

    const alert = await screen.findByRole('alert', { hidden: true })
    expect(alert.textContent).toContain('Failed to delete variation')
  })

  it('kebab -> merge opens MergeDialog with the chosen source and current HEAD as target', async () => {
    stateHolder.current.state = { head: 'main', branches }
    stateHolder.current.merge = vi.fn().mockResolvedValue({})
    render(<HeaderBranchChip workspaceId="s1" path="c1" />)
    const kebab = screen.getByTestId('header-branch-kebab')
    await userEvent.click(kebab)

    const mergeItem = await screen.findByText('feature-x')
    await userEvent.click(mergeItem)

    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('feature-x')
    expect(dialog.textContent).toContain('main')
    expect(stateHolder.current.merge).toHaveBeenCalledWith('feature-x', {
      into: 'main',
      dryRun: true,
    })
  })

  it('disables the merge entry point when mergeEnabled is false', async () => {
    stateHolder.current.state = { head: 'main', branches }
    stateHolder.current.merge = vi.fn().mockResolvedValue({})
    render(<HeaderBranchChip workspaceId="s1" path="c1" mergeEnabled={false} />)
    const kebab = screen.getByTestId('header-branch-kebab')
    await userEvent.click(kebab)

    const unavailable = await screen.findByText('Combine unavailable')
    expect(unavailable.getAttribute('data-disabled')).not.toBeNull()

    // The branch that would normally be a mergeable source must not appear
    // as a selectable item — the provider disabled merge entirely. The item
    // is aria-disabled, so it cannot be clicked at all (Radix blocks pointer
    // interaction on disabled menu items), which is itself the assertion
    // that a merge cannot be initiated through this menu.
    expect(screen.queryByText('feature-x')).toBeNull()
    expect(stateHolder.current.merge).not.toHaveBeenCalled()
  })

  it('keeps the rename target stable when HEAD changes while the rename dialog is open', async () => {
    stateHolder.current.state = { head: 'feature-x', branches }
    const { rerender } = render(<HeaderBranchChip workspaceId="s1" path="c1" />)
    const kebab = screen.getByTestId('header-branch-kebab')
    await userEvent.click(kebab)

    const renameItem = await screen.findByText(/Rename/)
    await userEvent.click(renameItem)

    // Simulate an external onHeadChanged update landing while the dialog is open.
    stateHolder.current.state = { head: 'main', branches }
    rerender(<HeaderBranchChip workspaceId="s1" path="c1" />)

    const input = await screen.findByPlaceholderText('feature-x')
    await userEvent.clear(input)
    await userEvent.type(input, 'renamed-branch{Enter}')

    expect(stateHolder.current.renameBranch).toHaveBeenCalledWith('feature-x', 'renamed-branch')
  })

  it('does not open MergeDialog when HEAD is stale (not yet present in the branches list)', async () => {
    // Simulates HEAD changing before the branches list has been refetched to
    // include it: `state.branches.find(b => b.name === head)` is undefined,
    // so a merge pick must not open MergeDialog with a null target.
    stateHolder.current.state = { head: 'ghost-branch', branches }
    render(<HeaderBranchChip workspaceId="s1" path="c1" />)
    const kebab = screen.getByTestId('header-branch-kebab')
    await userEvent.click(kebab)

    const mergeItem = await screen.findByText('feature-x')
    await userEvent.click(mergeItem)

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(stateHolder.current.merge).not.toHaveBeenCalled()
  })

  it('omits the unmerged-commits count when getBranchStats rejects during delete confirmation', async () => {
    stateHolder.current.state = { head: 'feature-x', branches }
    stateHolder.current.getBranchStats = vi.fn().mockRejectedValue(new Error('network error'))
    render(<HeaderBranchChip workspaceId="s1" path="c1" />)
    const kebab = screen.getByTestId('header-branch-kebab')
    await userEvent.click(kebab)

    const deleteItem = await screen.findByText(/Delete/)
    await userEvent.click(deleteItem)

    await screen.findByText(/Delete «feature-x»\?/)
    expect(screen.queryByText(/changes not yet combined remain/)).toBeNull()

    const confirmButton = await screen.findByRole('button', { name: 'Delete' })
    await userEvent.click(confirmButton)

    expect(stateHolder.current.deleteBranch).toHaveBeenCalledWith('feature-x')
  })

  it('keeps the merge target stable when HEAD changes while the merge dialog is open', async () => {
    stateHolder.current.state = { head: 'main', branches }
    stateHolder.current.merge = vi.fn().mockResolvedValue({})
    const { rerender } = render(<HeaderBranchChip workspaceId="s1" path="c1" />)
    const kebab = screen.getByTestId('header-branch-kebab')
    await userEvent.click(kebab)

    const mergeItem = await screen.findByText('feature-x')
    await userEvent.click(mergeItem)
    await screen.findByRole('dialog')

    // Simulate an external onHeadChanged update landing while the dialog is open.
    stateHolder.current.state = { head: 'feature-x', branches: [branches[1], branches[0]] }
    rerender(<HeaderBranchChip workspaceId="s1" path="c1" />)

    // Assert on the *last* call: a stale-target regression would fire a second
    // preview request for `into: 'feature-x'` once the dialog re-derives its
    // target from the (now-changed) HEAD, even though the first call above is
    // still correct.
    expect(stateHolder.current.merge).toHaveBeenLastCalledWith('feature-x', {
      into: 'main',
      dryRun: true,
    })
  })

  it('truncates a long HEAD name in kebab Rename/Delete with a title, like the switch dropdown', async () => {
    const longName = 'comprehensive-marketing-site-redesign-proposal-v2'
    const longBranches: BranchMeta[] = [
      branches[0],
      { name: longName, tipFrontiers: '', color: '#f97316', createdAt: '2026-04-23T01:00:00Z' },
    ]
    stateHolder.current.state = { head: longName, branches: longBranches }
    render(<HeaderBranchChip workspaceId="s1" path="c1" />)
    const kebab = screen.getByTestId('header-branch-kebab')
    await userEvent.click(kebab)

    const renameItem = await screen.findByText(new RegExp(`Rename.*${longName}`))
    const renameLabel = renameItem.closest('.truncate') ?? renameItem
    expect(renameLabel.className).toMatch(/\btruncate\b/)
    expect(renameLabel.getAttribute('title')).toContain(longName)

    const deleteItem = await screen.findByText(new RegExp(`Delete.*${longName}`))
    const deleteLabel = deleteItem.closest('.truncate') ?? deleteItem
    expect(deleteLabel.className).toMatch(/\btruncate\b/)
    expect(deleteLabel.getAttribute('title')).toContain(longName)
  })

  it('dismisses the "Variation" hover tooltip the moment the switch-variation dropdown opens', async () => {
    render(<HeaderBranchChip workspaceId="s1" path="c1" />)
    const chip = screen.getByTestId('header-branch-chip')

    // Hover first so the tooltip actually opens (delayDuration is 0). Radix
    // renders both a visible copy and a visually-hidden accessible copy of
    // the tooltip text, so assert via role (unique) rather than text.
    await userEvent.hover(chip)
    await screen.findByRole('tooltip')

    await userEvent.click(chip)

    // The dropdown opening is itself a press/click interaction on the same
    // trigger — the tooltip must not still be showing (overlapping the
    // dropdown) just because the pointer never physically left the chip.
    await screen.findByText('Switch variation')
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('does not reopen the tooltip when the dropdown returns focus to the chip on close', async () => {
    render(<HeaderBranchChip workspaceId="s1" path="c1" />)
    const chip = screen.getByTestId('header-branch-chip')

    await userEvent.hover(chip)
    await screen.findByRole('tooltip')
    await userEvent.click(chip)
    const option = await screen.findByText('feature-x')
    await userEvent.click(option)

    // Radix's dropdown returns focus to its trigger on close for
    // accessibility; since the same button is also the Tooltip's trigger,
    // that focus return must not itself reopen the hover tooltip.
    await waitFor(() => expect(stateHolder.current.setHead).toHaveBeenCalledWith('feature-x'))
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull())
  })

  it('does not poison the next hover when the dropdown closes without refocusing', async () => {
    render(<HeaderBranchChip workspaceId="s1" path="c1" />)
    const chip = screen.getByTestId('header-branch-chip')
    const kebab = screen.getByTestId('header-branch-kebab')

    // Open the switch-variation dropdown, then click the (separate) kebab
    // trigger. To the switch-variation dropdown this is an outside
    // interaction (closing it, since Radix's dismissable layer detects
    // outside interactions via pointerdown); the kebab's own click handler
    // then opens ITS OWN dropdown and takes focus — so the chip's dropdown
    // closes WITHOUT focus ever returning to the chip itself. Dispatch the
    // full pointerdown -> click sequence directly (bypassing the
    // actionability retry loop userEvent.click gets stuck in while the
    // first dropdown's overlay still intercepts pointer events).
    const clickThrough = (el: Element) => {
      fireEvent.pointerDown(el)
      fireEvent.mouseDown(el)
      fireEvent.pointerUp(el)
      fireEvent.mouseUp(el)
      fireEvent.click(el)
    }
    await userEvent.click(chip)
    await screen.findByText('Switch variation')
    clickThrough(kebab)
    await waitFor(() => expect(screen.queryByText('Switch variation')).toBeNull())
    await screen.findByText(/Combine into/)
    clickThrough(kebab) // close the kebab menu too, leaving focus off the chip

    // A later, entirely genuine hover on the chip must still show the
    // tooltip — the earlier close must not have permanently suppressed it.
    // (A brief pause first — a real user's next hover is never literally
    // the very next microtask after clicking elsewhere.)
    await new Promise((resolve) => setTimeout(resolve, 100))
    await userEvent.hover(chip)
    await screen.findByRole('tooltip')
  })
})
