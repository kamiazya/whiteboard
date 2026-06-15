import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
// Stub @excalidraw/excalidraw because roughjs does not resolve cleanly in this Vitest environment.
// The visual preview path is covered by browser-level verification.
vi.mock('@excalidraw/excalidraw', () => ({
  Excalidraw: () => null,
  exportToBlob: () => Promise.resolve(null),
}))
vi.mock('@excalidraw/excalidraw/index.css', () => ({}))
import { MergeDialog } from './MergeDialog.js'
import type { BranchMeta, MergeResult } from '../hooks/useBranches.js'

const main: BranchMeta = {
  name: 'main',
  tipFrontiers: '',
  color: '#1971c2',
  createdAt: '2026-04-23T00:00:00Z',
}
const feature: BranchMeta = {
  name: 'feature',
  tipFrontiers: 'AAECAw==',
  color: '#9333ea',
  createdAt: '2026-04-23T01:00:00Z',
}

afterEach(() => cleanup())

describe('MergeDialog', () => {
  it('calls runMerge with dryRun=true when opened', async () => {
    const runMerge = vi
      .fn<
        (source: string, args: { into: string; dryRun?: boolean }) => Promise<MergeResult>
      >()
      .mockResolvedValue({ badges: [], preview: { elementCount: 5 } })
    render(
      <MergeDialog
        open
        source={feature}
        target={main}
        onClose={() => undefined}
        runMerge={runMerge}
      />,
    )
    await waitFor(() => {
      expect(runMerge).toHaveBeenCalledWith('feature', { into: 'main', dryRun: true })
    })
  })

  it('shows the preview element count', async () => {
    const runMerge = vi
      .fn<(source: string, args: { into: string; dryRun?: boolean }) => Promise<MergeResult>>()
      .mockResolvedValue({ badges: [], preview: { elementCount: 42 } })
    render(
      <MergeDialog
        open
        source={feature}
        target={main}
        onClose={() => undefined}
        runMerge={runMerge}
      />,
    )
    expect(await screen.findByText(/42 elements/)).toBeTruthy()
  })

  it('renders badges as tone-specific chips', async () => {
    const runMerge = vi
      .fn<(source: string, args: { into: string; dryRun?: boolean }) => Promise<MergeResult>>()
      .mockResolvedValue({
        badges: [
          { type: 'resurrected', elementId: 'a' },
          { type: 'orphan_ref', elementId: 'arr', missingRef: 'X' },
          { type: 'field_merge', elementId: 'B', fields: ['strokeColor'] },
        ],
        preview: { elementCount: 10 },
      })
    render(
      <MergeDialog
        open
        source={feature}
        target={main}
        onClose={() => undefined}
        runMerge={runMerge}
      />,
    )
    expect(await screen.findByText(/Deleted element restored: a/)).toBeTruthy()
    expect(await screen.findByText(/Missing reference: arr -> X/)).toBeTruthy()
    expect(await screen.findByText(/Edited on both sides: B \(strokeColor\)/)).toBeTruthy()
  })

  it('shows the no-conflicts hint when there are no badges', async () => {
    const runMerge = vi
      .fn<(source: string, args: { into: string; dryRun?: boolean }) => Promise<MergeResult>>()
      .mockResolvedValue({ badges: [], preview: { elementCount: 5 } })
    render(
      <MergeDialog
        open
        source={feature}
        target={main}
        onClose={() => undefined}
        runMerge={runMerge}
      />,
    )
    expect(await screen.findByText(/No conflicts/)).toBeTruthy()
  })

  it('reruns merge with dryRun=false and calls onClose when confirmed', async () => {
    const runMerge = vi
      .fn<(source: string, args: { into: string; dryRun?: boolean }) => Promise<MergeResult>>()
      .mockResolvedValueOnce({ badges: [], preview: { elementCount: 5 } })
      .mockResolvedValueOnce({ badges: [], committed: { elementCount: 5 } })
    const onClose = vi.fn()
    render(
      <MergeDialog
        open
        source={feature}
        target={main}
        onClose={onClose}
        runMerge={runMerge}
      />,
    )
    // Wait for the dry run to complete.
    await screen.findByText(/5 elements/)
    // Click the confirm button by test id.
    const mergeBtn = screen.getByTestId('merge-confirm-button')
    fireEvent.click(mergeBtn)
    await waitFor(() => {
      expect(runMerge).toHaveBeenCalledTimes(2)
      expect(runMerge).toHaveBeenLastCalledWith('feature', { into: 'main', dryRun: false })
    })
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('calls onClose and does not run an extra merge when Cancel is clicked', async () => {
    const runMerge = vi
      .fn<(source: string, args: { into: string; dryRun?: boolean }) => Promise<MergeResult>>()
      .mockResolvedValue({ badges: [], preview: { elementCount: 5 } })
    const onClose = vi.fn()
    render(
      <MergeDialog
        open
        source={feature}
        target={main}
        onClose={onClose}
        runMerge={runMerge}
      />,
    )
    await screen.findByText(/5 elements/)
    const cancelBtn = screen.getByRole('button', { name: /Cancel/ })
    fireEvent.click(cancelBtn)
    expect(onClose).toHaveBeenCalled()
    expect(runMerge).toHaveBeenCalledTimes(1) // dry run only
  })

  it('shows element counts in the target and source columns too', async () => {
    const runMerge = vi
      .fn<(source: string, args: { into: string; dryRun?: boolean }) => Promise<MergeResult>>()
      .mockResolvedValue({
        badges: [],
        preview: { elementCount: 27 },
        target: { elementCount: 23 },
        source: { elementCount: 26 },
      })
    render(
      <MergeDialog
        open
        source={feature}
        target={main}
        onClose={() => undefined}
        runMerge={runMerge}
      />,
    )
    expect(await screen.findByText(/23 elements/)).toBeTruthy()
    expect(await screen.findByText(/26 elements/)).toBeTruthy()
    expect(await screen.findByText(/27 elements/)).toBeTruthy()
    // delta display (source - target = +3)
    expect(await screen.findByText(/\+3/)).toBeTruthy()
  })

  it('shows a safe fallback copy when runMerge throws an Error (never exposes Error.message)', async () => {
    const runMerge = vi
      .fn<(source: string, args: { into: string; dryRun?: boolean }) => Promise<MergeResult>>()
      .mockRejectedValue(new Error('internal: token=secret-abc'))
    render(
      <MergeDialog
        open
        source={feature}
        target={main}
        onClose={() => undefined}
        runMerge={runMerge}
      />,
    )
    await screen.findByText(/preview failed/i)
    // The raw Error.message must never reach the UI (P-HTTP-005).
    expect(screen.queryByText(/secret-abc/i)).toBeNull()
    expect(screen.queryByText(/internal:/i)).toBeNull()
  })

  it('shows body.title when runMerge rejects with a Problem Details error', async () => {
    const err = {
      status: 409,
      body: {
        type: 'https://example.com/problems/branch_conflict',
        title: 'Branch already exists',
        status: 409,
      },
    }
    const runMerge = vi
      .fn<(source: string, args: { into: string; dryRun?: boolean }) => Promise<MergeResult>>()
      .mockRejectedValue(err)
    render(
      <MergeDialog
        open
        source={feature}
        target={main}
        onClose={() => undefined}
        runMerge={runMerge}
      />,
    )
    await screen.findByText(/branch already exists/i)
  })
})
