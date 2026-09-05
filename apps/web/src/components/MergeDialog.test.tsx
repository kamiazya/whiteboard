import type {
  BranchMeta,
  MergeResponse,
  VersionEntry,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/index'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DaemonApiContext } from '@/contexts/DaemonApiContext'
import { MERGE_COMMITTED_EVENT, mergeCommittedDetailSchema } from '@/lib/merge-committed-event'
import { MergeDialog } from './MergeDialog.js'

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

function versionEntry(overrides: Partial<VersionEntry>): VersionEntry {
  return {
    id: 'v0',
    path: 'c1',
    createdAt: '2026-04-23T00:00:00Z',
    elementCount: 1,
    auto: false,
    hasThumbnail: true,
    branchName: 'main',
    ...overrides,
  }
}

beforeEach(() => {
  // The thumbnail-fallback effect calls apiFetch(.../versions) whenever workspaceId/path
  // are provided; default to an empty (but schema-valid) list so tests that don't care
  // about thumbnails resolve deterministically instead of hitting the real network.
  const fetchMock = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify({ versions: [] }), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('MergeDialog', () => {
  it('calls runMerge with dryRun=true when opened', async () => {
    const runMerge = vi
      .fn<(source: string, args: { into: string; dryRun?: boolean }) => Promise<MergeResponse>>()
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
      .fn<(source: string, args: { into: string; dryRun?: boolean }) => Promise<MergeResponse>>()
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
      .fn<(source: string, args: { into: string; dryRun?: boolean }) => Promise<MergeResponse>>()
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
      .fn<(source: string, args: { into: string; dryRun?: boolean }) => Promise<MergeResponse>>()
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

  it('reruns merge with dryRun=false, dispatches a schema-valid merge_committed event, and calls onClose when confirmed', async () => {
    const runMerge = vi
      .fn<(source: string, args: { into: string; dryRun?: boolean }) => Promise<MergeResponse>>()
      .mockResolvedValueOnce({ badges: [], preview: { elementCount: 5 } })
      .mockResolvedValueOnce({
        badges: [],
        committed: { elementCount: 5 },
        newElementIds: ['a'],
        conflictElementIds: [],
        preMergeVersionId: 'v-pre',
      })
    const onClose = vi.fn()
    // Drift guard: capture the ACTUAL dispatched CustomEvent (not a hand-built
    // fixture) and assert it parses with the shared schema.
    const captured: Event[] = []
    const listener = (event: Event) => captured.push(event)
    window.addEventListener(MERGE_COMMITTED_EVENT, listener)
    render(
      <MergeDialog
        open
        source={feature}
        target={main}
        onClose={onClose}
        runMerge={runMerge}
        workspaceId="w1"
        path="c1"
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
    window.removeEventListener(MERGE_COMMITTED_EVENT, listener)
    expect(captured).toHaveLength(1)
    const detail = (captured[0] as CustomEvent).detail
    const parsed = mergeCommittedDetailSchema.parse(detail)
    expect(parsed.workspaceId).toBe('w1')
    expect(parsed.path).toBe('c1')
    expect(parsed.newElementIds).toEqual(['a'])
  })

  it('does not dispatch merge_committed when workspaceId/path are absent', async () => {
    const runMerge = vi
      .fn<(source: string, args: { into: string; dryRun?: boolean }) => Promise<MergeResponse>>()
      .mockResolvedValueOnce({ badges: [], preview: { elementCount: 5 } })
      .mockResolvedValueOnce({ badges: [], committed: { elementCount: 5 } })
    const onClose = vi.fn()
    const captured: Event[] = []
    const listener = (event: Event) => captured.push(event)
    window.addEventListener(MERGE_COMMITTED_EVENT, listener)
    render(
      <MergeDialog open source={feature} target={main} onClose={onClose} runMerge={runMerge} />,
    )
    await screen.findByText(/5 elements/)
    fireEvent.click(screen.getByTestId('merge-confirm-button'))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    window.removeEventListener(MERGE_COMMITTED_EVENT, listener)
    expect(captured).toHaveLength(0)
  })

  it('calls onClose and does not run an extra merge when Cancel is clicked', async () => {
    const runMerge = vi
      .fn<(source: string, args: { into: string; dryRun?: boolean }) => Promise<MergeResponse>>()
      .mockResolvedValue({ badges: [], preview: { elementCount: 5 } })
    const onClose = vi.fn()
    render(
      <MergeDialog open source={feature} target={main} onClose={onClose} runMerge={runMerge} />,
    )
    await screen.findByText(/5 elements/)
    const cancelBtn = screen.getByRole('button', { name: /Cancel/ })
    fireEvent.click(cancelBtn)
    expect(onClose).toHaveBeenCalled()
    expect(runMerge).toHaveBeenCalledTimes(1) // dry run only
  })

  it('shows element counts in the target and source columns too', async () => {
    const runMerge = vi
      .fn<(source: string, args: { into: string; dryRun?: boolean }) => Promise<MergeResponse>>()
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

  it('does not show the reassuring no-conflicts banner when the preview fetch failed', async () => {
    const runMerge = vi
      .fn<(source: string, args: { into: string; dryRun?: boolean }) => Promise<MergeResponse>>()
      .mockRejectedValue(new Error('boom'))
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
    expect(screen.queryByText(/No conflicts/)).toBeNull()
  })

  it('clears stale thumbnails when a version refetch responds non-ok', async () => {
    const versions: VersionEntry[] = [
      versionEntry({ id: 'feature-v1', branchName: 'feature', createdAt: '2026-04-23T05:00:00Z' }),
    ]
    const fetchMock = vi
      .fn(async (input: RequestInfo | URL) =>
        String(input).includes('/thumbnail')
          ? new Response(new Blob(['png']), { status: 200 })
          : new Response('nope', { status: 500 }),
      )
      .mockImplementationOnce(
        async () => new Response(JSON.stringify({ versions }), { status: 200 }),
      )
    vi.stubGlobal('fetch', fetchMock)
    const runMerge = vi
      .fn<(source: string, args: { into: string; dryRun?: boolean }) => Promise<MergeResponse>>()
      .mockResolvedValue({ badges: [], preview: { elementCount: 5 } })
    const { rerender } = render(
      <MergeDialog
        open
        source={feature}
        target={main}
        onClose={() => undefined}
        runMerge={runMerge}
        workspaceId="w1"
        path="c1"
      />,
    )
    const sourceCard = await screen.findByTestId('merge-branch-card-source')
    // The picture comes from the keeper now, so what it is drawn FROM is an
    // object URL rather than the route. What this case is about is the
    // clearing below, so it waits for a picture rather than naming one.
    await waitFor(() => {
      expect(sourceCard.querySelector('img')).not.toBeNull()
    })
    // Switch the source branch so the effect re-runs and the follow-up fetch fails.
    const otherFeature: BranchMeta = { ...feature, name: 'other-feature' }
    rerender(
      <MergeDialog
        open
        source={otherFeature}
        target={main}
        onClose={() => undefined}
        runMerge={runMerge}
        workspaceId="w1"
        path="c1"
      />,
    )
    await waitFor(() => {
      expect(screen.queryByTestId('merge-branch-card-source')?.querySelector('img')).toBeNull()
    })
  })

  it('shows a safe fallback copy when runMerge throws an Error (never exposes Error.message)', async () => {
    const runMerge = vi
      .fn<(source: string, args: { into: string; dryRun?: boolean }) => Promise<MergeResponse>>()
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
      .fn<(source: string, args: { into: string; dryRun?: boolean }) => Promise<MergeResponse>>()
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

  it('renders a complete, correctly-ordered combine title, capitalizing the default variation', async () => {
    const runMerge = vi
      .fn<(source: string, args: { into: string; dryRun?: boolean }) => Promise<MergeResponse>>()
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
    const title = await screen.findByText(/Combine.*into/)
    expect(title.textContent).toBe('Combine «feature» into «Main»')
  })

  it('shows the post-merge side-effect notice for a non-main source', async () => {
    const runMerge = vi
      .fn<(source: string, args: { into: string; dryRun?: boolean }) => Promise<MergeResponse>>()
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
    const notice = await screen.findByTestId('merge-side-effect-notice')
    expect(notice.textContent).toContain('Main')
    expect(notice.textContent).toContain('feature')
  })

  it('hides the post-merge side-effect notice when the source is main', async () => {
    const runMerge = vi
      .fn<(source: string, args: { into: string; dryRun?: boolean }) => Promise<MergeResponse>>()
      .mockResolvedValue({ badges: [], preview: { elementCount: 5 } })
    render(
      <MergeDialog
        open
        source={main}
        target={feature}
        onClose={() => undefined}
        runMerge={runMerge}
      />,
    )
    await screen.findByText(/5 elements/)
    expect(screen.queryByTestId('merge-side-effect-notice')).toBeNull()
  })

  it('hides the post-merge side-effect notice when source and target names match', async () => {
    const runMerge = vi
      .fn<(source: string, args: { into: string; dryRun?: boolean }) => Promise<MergeResponse>>()
      .mockResolvedValue({ badges: [], preview: { elementCount: 5 } })
    const sameNameTarget: BranchMeta = { ...feature, color: '#000000' }
    render(
      <MergeDialog
        open
        source={feature}
        target={sameNameTarget}
        onClose={() => undefined}
        runMerge={runMerge}
      />,
    )
    await screen.findByText(/5 elements/)
    expect(screen.queryByTestId('merge-side-effect-notice')).toBeNull()
  })

  it('renders the latest thumbnail per branch, picking the newest when several match', async () => {
    const versions: VersionEntry[] = [
      versionEntry({ id: 'main-old', branchName: 'main', createdAt: '2026-04-22T00:00:00Z' }),
      versionEntry({ id: 'main-new', branchName: 'main', createdAt: '2026-04-23T12:00:00Z' }),
      versionEntry({
        id: 'feature-only',
        branchName: 'feature',
        createdAt: '2026-04-23T05:00:00Z',
      }),
      // No thumbnail: must be excluded from candidates even though it is the newest.
      versionEntry({
        id: 'feature-no-thumb',
        branchName: 'feature',
        createdAt: '2026-04-23T23:00:00Z',
        hasThumbnail: false,
      }),
    ]
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ versions }), { status: 200 })),
    )
    const runMerge = vi
      .fn<(source: string, args: { into: string; dryRun?: boolean }) => Promise<MergeResponse>>()
      .mockResolvedValue({ badges: [], preview: { elementCount: 5 } })
    render(
      <MergeDialog
        open
        source={feature}
        target={main}
        onClose={() => undefined}
        runMerge={runMerge}
        workspaceId="w1"
        path="c1"
      />,
    )
    await screen.findByTestId('merge-branch-card-source')
    await screen.findByTestId('merge-branch-card-target')
    // Which POINT each card picked, asserted on what was asked for rather
    // than on an <img src>: the picture is the keeper's to hand over now, and
    // an object URL says nothing about the choice this case is about.
    const asked = () =>
      (vi.mocked(fetch).mock.calls as [RequestInfo | URL][])
        .map(([input]) => String(input))
        .filter((url) => url.includes('/thumbnail'))
    await waitFor(() => {
      expect(asked()).toContain('/api/workspaces/w1/documents/c1/versions/feature-only/thumbnail')
    })
    await waitFor(() => {
      expect(asked()).toContain('/api/workspaces/w1/documents/c1/versions/main-new/thumbnail')
    })
  })

  it('gives the Combined preview panel a dark-mode-aware surface, not a hardcoded white background', async () => {
    const runMerge = vi
      .fn<(source: string, args: { into: string; dryRun?: boolean }) => Promise<MergeResponse>>()
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
    await screen.findByText(/5 elements/)
    const previewCard = screen.getByTestId('merge-branch-card-preview')
    const previewSurface = previewCard.querySelector('.relative.h-\\[340px\\]')
    expect(previewSurface).not.toBeNull()
    expect(previewSurface?.className).not.toMatch(/\bbg-white\b/)
  })

  it('tells the user which variation to open and save to generate the combined preview', async () => {
    const runMerge = vi
      .fn<(source: string, args: { into: string; dryRun?: boolean }) => Promise<MergeResponse>>()
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
    // Unambiguous: names the comparison-side variation and says to OPEN it,
    // not just "save" (which reads as if the currently-open canvas suffices).
    expect(await screen.findByText(/Open «feature» and save with ⌘S/)).toBeTruthy()
  })

  it('fetches versions and renders thumbnails through the authorized daemon fetch in cross-origin daemon mode', async () => {
    // Thumbnails are fetchable in daemon mode via VersionThumbnail's
    // authorized fetch + objectURL — the dialog's own versions fetch (used to
    // resolve which version id has the latest thumbnail per branch) must run
    // through the same daemon-provided fetch, not the global one.
    const originalCreateObjectURL = URL.createObjectURL
    const originalRevokeObjectURL = URL.revokeObjectURL
    const createObjectURL = vi.fn(() => 'blob:mock-1')
    URL.createObjectURL = createObjectURL
    URL.revokeObjectURL = vi.fn()

    const versions: VersionEntry[] = [
      versionEntry({ id: 'feature-v1', branchName: 'feature', createdAt: '2026-04-23T05:00:00Z' }),
    ]
    const daemonFetch = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/thumbnail')) {
        return Promise.resolve(new Response(new Blob(['png']), { status: 200 }))
      }
      return Promise.resolve(new Response(JSON.stringify({ versions }), { status: 200 }))
    })
    const globalFetch = vi.mocked(fetch)
    const runMerge = vi
      .fn<(source: string, args: { into: string; dryRun?: boolean }) => Promise<MergeResponse>>()
      .mockResolvedValue({ badges: [], preview: { elementCount: 5 } })
    render(
      <DaemonApiContext.Provider value={daemonFetch}>
        <MergeDialog
          open
          source={feature}
          target={main}
          onClose={() => undefined}
          runMerge={runMerge}
          workspaceId="w1"
          path="c1"
        />
      </DaemonApiContext.Provider>,
    )
    await screen.findByText(/5 elements/)
    expect(
      daemonFetch.mock.calls.some(([reqInput]) => String(reqInput).includes('/versions')),
    ).toBe(true)
    expect(globalFetch).not.toHaveBeenCalled()
    const sourceCard = await screen.findByTestId('merge-branch-card-source')
    await waitFor(() => expect(sourceCard.querySelector('img')).not.toBeNull())
    expect(sourceCard.querySelector('img')?.getAttribute('src')).toBe('blob:mock-1')

    URL.createObjectURL = originalCreateObjectURL
    URL.revokeObjectURL = originalRevokeObjectURL
  })
})
