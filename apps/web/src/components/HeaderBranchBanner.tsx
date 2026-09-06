import { AlertTriangle, GitMerge } from 'lucide-react'
import { type JSX, useEffect, useRef, useState } from 'react'
import { Button } from '../components/ui/button.js'
import type { MergeResult } from '../hooks/useBranches.js'
import { useBranches } from '../hooks/useBranches.js'
import { MERGE_COMMITTED_EVENT, parseMergeCommittedEvent } from '../lib/merge-committed-event.js'
import { displayBranchName } from '../lib/utils.js'
import { MergeDialog } from './MergeDialog'

// Show a banner under the header when the current branch is ahead of main.
// - Condition: HEAD !== 'main' and getBranchStats(HEAD).unmergedCommits > 0
// - Clicking the CTA opens MergeDialog directly with source=HEAD and target=main
// - Refresh whenever HEAD or branches change; failures stay silent and simply hide the banner
//
// Unlike the packages/mcp-server original, this component does not subscribe to an
// "whiteboard:head_changed" window event: apps/web's useBranches has no such
// broadcast, so external HEAD changes reach this component passively through
// its own hook state (a future caller wires useDocumentSync.onHeadChanged ->
// branches.refetch()). merge_committed stays a window event, but is parsed
// through the shared Zod contract instead of a hand-written detail cast.

export interface HeaderBranchBannerProps {
  workspaceId: string
  path: string
  /**
   * Bumped when the keeper's state may have moved under this component —
   * the same signal the chip beside it takes, and for a reason that is not
   * cosmetic on a browser-kept document: its record is not readable at mount,
   * so `useBranches`' own first read answers the resting state (HEAD `main`)
   * and nothing re-read it once the record arrived. Without this, a document
   * opened ON a variation showed the default one and this banner never
   * appeared at all.
   */
  refreshSignal?: number
}

export function HeaderBranchBanner({
  workspaceId,
  path,
  refreshSignal,
}: HeaderBranchBannerProps): JSX.Element | null {
  const { state, getBranchStats, merge: runMerge, refetch } = useBranches(workspaceId, path)
  // Skip the initial mount, as the chip does: `useBranches` refetches on its
  // own there, and only a value that CHANGES afterwards means something moved.
  const prevRefreshSignalRef = useRef(refreshSignal)
  useEffect(() => {
    if (prevRefreshSignalRef.current === refreshSignal) return
    prevRefreshSignalRef.current = refreshSignal
    void refetch()
  }, [refreshSignal, refetch])
  const head = state.head
  const targetBranch = state.branches.find((b) => b.name === 'main')
  const sourceBranch = state.branches.find((b) => b.name === head)
  const [unmergedCommits, setUnmergedCommits] = useState(0)
  const [mergeOpen, setMergeOpen] = useState(false)

  // Shared loader for unmerged stats. Skip work and force 0 while HEAD is main.
  // Refetch on direct head changes and merge_committed events.
  useEffect(() => {
    let cancelled = false
    const refresh = async () => {
      if (head === 'main') {
        if (!cancelled) setUnmergedCommits(0)
        return
      }
      try {
        const s = await getBranchStats(head)
        if (!cancelled) setUnmergedCommits(s.unmergedCommits)
      } catch {
        if (!cancelled) setUnmergedCommits(0)
      }
    }
    refresh()
    if (typeof window === 'undefined') {
      return () => {
        cancelled = true
      }
    }
    const onMergeCommitted = (event: Event) => {
      const detail = parseMergeCommittedEvent(event)
      if (!detail) return
      if (detail.workspaceId !== workspaceId || detail.path !== path) return
      void refresh()
    }
    window.addEventListener(MERGE_COMMITTED_EVENT, onMergeCommitted)
    return () => {
      cancelled = true
      window.removeEventListener(MERGE_COMMITTED_EVENT, onMergeCommitted)
    }
  }, [head, getBranchStats, workspaceId, path])

  const visible = head !== 'main' && unmergedCommits > 0 && !!targetBranch && !!sourceBranch

  if (!visible) return null

  return (
    <>
      <div
        role="status"
        data-testid="header-branch-banner"
        className="flex items-center gap-3 border-b border-amber-400/40 bg-amber-50 px-3 py-1.5 text-xs text-amber-900"
      >
        <AlertTriangle className="size-3.5 shrink-0 text-amber-600" aria-hidden />
        <span className="min-w-0 flex-1 truncate">
          Variation «<strong>{displayBranchName(head)}</strong>» has{' '}
          <strong>{unmergedCommits}</strong> changes not yet combined into «Main»
        </span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 gap-1 border-amber-400/60 bg-amber-100/70 text-xs text-amber-900 hover:bg-amber-200"
          data-testid="header-branch-banner-merge"
          onClick={() => setMergeOpen(true)}
        >
          <GitMerge className="size-3.5" />
          Combine into «Main»
        </Button>
      </div>
      <MergeDialog
        open={mergeOpen}
        source={sourceBranch ?? null}
        target={targetBranch ?? null}
        onClose={() => setMergeOpen(false)}
        runMerge={(src, args) => runMerge(src, args) as Promise<MergeResult>}
        workspaceId={workspaceId}
        path={path}
      />
    </>
  )
}
