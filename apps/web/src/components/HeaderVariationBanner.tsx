import { Eye, GitMerge, X } from 'lucide-react'
import { type JSX, useState } from 'react'
import { Button } from '../components/ui/button.js'
import type { BranchMeta, MergeResult } from '../hooks/useBranches.js'
import { displayBranchName } from '../lib/utils.js'
import { MergeDialog } from './MergeDialog'

// The banner over a `?v=<name>` variation preview (ADR-0022's addressability
// increment). The preview itself is read-only by construction
// (DocumentPreview); this banner carries the two ways FORWARD from looking:
// switching HEAD — kept an explicit control because it is a shared act that
// moves every peer — and combining the variation into the current HEAD.
export interface HeaderVariationBannerProps {
  workspaceId: string
  path: string
  /** The previewed variation. Never the default: `?v=main` strips upstream. */
  name: string
  head: string
  branches: readonly BranchMeta[]
  onSwitch: () => void
  onExit: () => void
  runMerge: (source: string, args: { into: string; dryRun?: boolean }) => Promise<MergeResult>
}

export function HeaderVariationBanner({
  workspaceId,
  path,
  name,
  head,
  branches,
  onSwitch,
  onExit,
  runMerge,
}: HeaderVariationBannerProps): JSX.Element {
  const [mergeOpen, setMergeOpen] = useState(false)
  const sourceBranch = branches.find((b) => b.name === name) ?? null
  const targetBranch = branches.find((b) => b.name === head) ?? null

  return (
    <>
      <div
        role="status"
        data-testid="variation-preview-banner"
        className="flex items-center gap-3 border-b border-sky-400/40 bg-sky-50 px-3 py-1.5 text-xs text-sky-900"
      >
        <Eye className="size-3.5 shrink-0 text-sky-600" aria-hidden />
        <span className="min-w-0 flex-1 truncate">
          Viewing variation «<strong>{displayBranchName(name)}</strong>» — read-only. The document
          stays on «{displayBranchName(head)}».
        </span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 gap-1 border-sky-400/60 bg-sky-100/70 text-xs text-sky-900 hover:bg-sky-200"
          data-testid="variation-preview-switch"
          title="Switches the document for everyone working on it"
          onClick={onSwitch}
        >
          Switch to this variation
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 gap-1 border-sky-400/60 bg-sky-100/70 text-xs text-sky-900 hover:bg-sky-200"
          data-testid="variation-preview-merge"
          onClick={() => setMergeOpen(true)}
        >
          <GitMerge className="size-3.5" />
          Combine into «{displayBranchName(head)}»
        </Button>
        <button
          type="button"
          aria-label="Back to the current document"
          data-testid="variation-preview-exit"
          className="shrink-0 rounded-md p-1 text-sky-700 hover:bg-sky-200"
          onClick={onExit}
        >
          <X className="size-3.5" aria-hidden />
        </button>
      </div>
      <MergeDialog
        open={mergeOpen}
        source={sourceBranch}
        target={targetBranch}
        onClose={() => setMergeOpen(false)}
        runMerge={runMerge}
        workspaceId={workspaceId}
        path={path}
      />
    </>
  )
}
