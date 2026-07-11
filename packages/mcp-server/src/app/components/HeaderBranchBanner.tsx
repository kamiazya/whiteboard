import { useEffect, useMemo, useState, type JSX } from 'react'
import { AlertTriangle, GitMerge } from 'lucide-react'
import { Button } from './ui/button.js'
import { MergeDialog } from './MergeDialog.js'
import type { BranchMeta, MergeResult } from '../hooks/useBranches.js'
import { useBranches } from '../hooks/useBranches.js'
import { displayBranchName } from '@/lib/utils'

// Show a banner under the header when the current branch is ahead of main.
// - Condition: HEAD !== 'main' and getBranchStats(HEAD).unmergedCommits > 0
// - Clicking the CTA opens MergeDialog directly with source=HEAD and target=main
// - Refresh whenever HEAD or branches change; failures stay silent and simply hide the banner

export interface HeaderBranchBannerProps {
  workspaceId: string
  slug: string
}

export function HeaderBranchBanner({
  workspaceId,
  slug,
}: HeaderBranchBannerProps): JSX.Element | null {
  const { state, getBranchStats, merge: runMerge } = useBranches(workspaceId, slug)
  const head = state.head
  const targetBranch: BranchMeta | undefined = state.branches.find((b) => b.name === 'main')
  const sourceBranch: BranchMeta | undefined = state.branches.find((b) => b.name === head)
  const [unmergedCommits, setUnmergedCommits] = useState<number>(0)
  const [mergeOpen, setMergeOpen] = useState(false)

  // Shared loader for unmerged stats. Skip work and force 0 while HEAD is main.
  // Refetch on direct head changes, remote head_changed events, and merge_committed events.
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
    const onHeadChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ workspaceId: string; slug: string }>).detail
      if (!detail) return
      if (detail.workspaceId !== workspaceId || detail.slug !== slug) return
      void refresh()
    }
    const onMergeCommitted = (event: Event) => {
      const detail = (event as CustomEvent<{ workspaceId: string; slug: string }>).detail
      if (!detail) return
      if (detail.workspaceId !== workspaceId || detail.slug !== slug) return
      void refresh()
    }
    window.addEventListener('excalidraw:head_changed', onHeadChanged)
    window.addEventListener('excalidraw:merge_committed', onMergeCommitted)
    return () => {
      cancelled = true
      window.removeEventListener('excalidraw:head_changed', onHeadChanged)
      window.removeEventListener('excalidraw:merge_committed', onMergeCommitted)
    }
  }, [head, getBranchStats, workspaceId, slug])

  const visible = useMemo(
    () => head !== 'main' && unmergedCommits > 0 && !!targetBranch && !!sourceBranch,
    [head, unmergedCommits, targetBranch, sourceBranch],
  )

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
        slug={slug}
      />
    </>
  )
}

export default HeaderBranchBanner
