import type { BranchMeta } from '@kamiazya/whiteboard-mcp/api-contracts'
import {
  ChevronDown,
  GitBranch,
  GitMerge,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react'
import { type JSX, lazy, Suspense, useEffect, useRef, useState } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useDaemonApi } from '@/contexts/DaemonApiContext'
import type { MergeResult } from '@/hooks/useBranches'
import { useBranches } from '@/hooks/useBranches'
import { safeErrorCopy } from '@/lib/error-copy'
import { cn, displayBranchName } from '@/lib/utils'

// MergeDialog pulls in its own thumbnail-fetch effect and a second Dialog
// surface; loading it on demand keeps it out of the daemon-canvas chunk
// until a merge is actually initiated.
const MergeDialog = lazy(() => import('./MergeDialog').then((m) => ({ default: m.MergeDialog })))

// Consolidate branch operations into a single `●branch▾` chip in the header.
// UI copy uses the Variation/Combine vocabulary; the underlying data model,
// hook, and MCP tool calls keep their git-derived identifiers (branch, merge)
// unchanged.
//
// Behavior:
//   - Left trigger: switch variations from a dropdown
//   - Right kebab: rename, delete, or combine from another variation
//   - New variation: inline form inside the dropdown
//
// Unlike the old tab layout, there is always exactly one visible chip for HEAD.
// Other variations are managed through the dropdown and kebab menu.

export interface HeaderBranchChipProps {
  workspaceId: string
  slug: string
  disabled?: boolean
  // Bump this (e.g. a counter) when an external event (WS-observed HEAD
  // change from another client) should force a list refresh. The chip's own
  // mutations (create/rename/delete/setHead) already refetch internally, so
  // this only needs to cover changes this component did not itself trigger.
  refreshSignal?: number
  // The provider capability contract: switching/creating/renaming/deleting
  // branches does not imply merge is available. Defaults to true so existing
  // callers that only gate on `capabilities.branches` keep today's behavior;
  // callers must pass `capabilities.merge` explicitly to hide the merge
  // entry point when the provider does not support it.
  mergeEnabled?: boolean
}

interface PendingMerge {
  source: BranchMeta
  target: BranchMeta | null
}

// Same ellipsis + title-attribute truncation the switch-variation dropdown
// uses for branch names (below): a menu action whose label embeds a
// user-chosen variation name must not push the menu wider than its fixed
// width or wrap the destructive Delete label across several lines.
function TruncatedMenuLabel({ text }: { text: string }): JSX.Element {
  return (
    <span className="min-w-0 flex-1 truncate" title={text}>
      {text}
    </span>
  )
}

export function HeaderBranchChip({
  workspaceId,
  slug,
  disabled,
  refreshSignal,
  mergeEnabled = true,
}: HeaderBranchChipProps): JSX.Element {
  const fetchFn = useDaemonApi()
  const {
    state,
    refetch,
    createBranch,
    deleteBranch,
    getBranchStats,
    renameBranch,
    setHead,
    merge: runMerge,
  } = useBranches(workspaceId, slug, fetchFn)

  // Skip the initial mount (refetch already runs internally via useBranches'
  // own effect) — only react to a refreshSignal value that actually changes
  // after mount, i.e. an externally observed HEAD change.
  const prevRefreshSignalRef = useRef(refreshSignal)
  useEffect(() => {
    if (prevRefreshSignalRef.current === refreshSignal) return
    prevRefreshSignalRef.current = refreshSignal
    void refetch()
  }, [refreshSignal, refetch])

  const head = state.head
  const activeBranch = state.branches.find((b) => b.name === head)
  const otherBranches = state.branches.filter((b) => b.name !== head)

  // Surface create/rename/delete failures through one shared inline error banner.
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  // Create branch state for the inline dropdown form.
  const [createOpen, setCreateOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const submitCreate = async () => {
    const name = newName.trim()
    if (!name) return
    try {
      await createBranch({ name })
      setNewName('')
      setCreateOpen(false)
      setErrorMessage(null)
    } catch (err) {
      setErrorMessage(safeErrorCopy(err, 'Failed to create variation'))
    }
  }

  // Rename state. Snapshot the branch being renamed at open time so a HEAD
  // change while the dialog is open (e.g. from an external onHeadChanged
  // update) cannot redirect the rename onto a different branch.
  const [renameOpen, setRenameOpen] = useState(false)
  const [renameTarget, setRenameTarget] = useState<BranchMeta | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const openRename = () => {
    if (!activeBranch) return
    // Errors from a previous operation (e.g. a failed create) must not
    // greet the user inside a fresh rename dialog.
    setErrorMessage(null)
    setRenameTarget(activeBranch)
    setRenameDraft(activeBranch.name)
    setRenameOpen(true)
  }
  const submitRename = async () => {
    if (!renameTarget) return
    const next = renameDraft.trim()
    if (!next || next === renameTarget.name) {
      setRenameOpen(false)
      return
    }
    try {
      await renameBranch(renameTarget.name, next)
      setRenameOpen(false)
      setErrorMessage(null)
    } catch (err) {
      setErrorMessage(safeErrorCopy(err, 'Failed to rename variation'))
    }
  }

  // Delete state plus unmerged commit stats.
  const [pendingDelete, setPendingDelete] = useState<BranchMeta | null>(null)
  const [pendingStats, setPendingStats] = useState<{ unmergedCommits: number } | null>(null)
  const [deleting, setDeleting] = useState(false)
  useEffect(() => {
    if (!pendingDelete) {
      setPendingStats(null)
      return
    }
    let cancelled = false
    setPendingStats(null)
    getBranchStats(pendingDelete.name)
      .then((s) => {
        if (!cancelled) setPendingStats({ unmergedCommits: s.unmergedCommits })
      })
      .catch(() => {
        /* If stats fail, just omit the count. */
      })
    return () => {
      cancelled = true
    }
  }, [pendingDelete, getBranchStats])

  // Merge state. Reuse MergeDialog with source=chosen and target=HEAD.
  // Snapshot both source and target together when the user picks a branch to
  // merge, so a HEAD change while the dialog is open cannot merge into a
  // different target than the one shown when the action was chosen.
  const [pendingMerge, setPendingMerge] = useState<PendingMerge | null>(null)

  const chipColor = activeBranch?.color ?? '#64748b'

  // Radix marks background content inert/aria-hidden while a dropdown or
  // dialog is open, so an error raised inside one of those flows must render
  // *inside* the still-open surface to stay visible and announced — a copy
  // rendered only in the header row would be hidden until the user closes it.
  const errorBanner = errorMessage ? (
    <div
      role="alert"
      className="flex max-w-[200px] items-center gap-1 text-[11px] text-destructive"
    >
      <span aria-hidden>⚠</span>
      <span className="truncate" title={errorMessage}>
        {errorMessage}
      </span>
      <button
        type="button"
        className="ml-auto text-muted-foreground hover:text-foreground"
        onClick={() => setErrorMessage(null)}
        aria-label="Dismiss error"
      >
        ×
      </button>
    </div>
  ) : null

  return (
    <div className="flex items-center gap-1">
      {/* Main chip: branch switching and creation live in this dropdown. */}
      <DropdownMenu
        onOpenChange={(open) => {
          if (open) {
            // A stale error from the previous interaction shouldn't greet
            // the user when they re-open the menu.
            setErrorMessage(null)
          } else {
            setCreateOpen(false)
            setNewName('')
          }
        }}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                disabled={disabled}
                aria-label={`Switch variation (current: ${head})`}
                data-testid="header-branch-chip"
                className={cn(
                  'flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium',
                  'max-w-[220px] transition-colors hover:bg-accent disabled:opacity-60',
                )}
                style={{ borderColor: chipColor, color: chipColor }}
              >
                <span
                  aria-hidden
                  className="inline-block size-2 shrink-0 rounded-full"
                  style={{ background: chipColor }}
                />
                <span className="truncate" title={head}>
                  {displayBranchName(head)}
                </span>
                <ChevronDown className="size-3 shrink-0 opacity-70" aria-hidden />
              </button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>Variation</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="start" className="w-[240px]">
          <DropdownMenuLabel className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider">
            <GitBranch className="size-3" />
            Switch variation
          </DropdownMenuLabel>
          {/* Show HEAD first and mark it as the current variation. */}
          <DropdownMenuItem onSelect={(e) => e.preventDefault()} className="gap-2" disabled>
            <span
              aria-hidden
              className="inline-block size-2 rounded-full"
              style={{ background: chipColor }}
            />
            <span className="truncate">{displayBranchName(head)}</span>
            <span className="ml-auto text-[10px] text-muted-foreground">Current</span>
          </DropdownMenuItem>
          {otherBranches.map((b) => (
            <DropdownMenuItem
              key={b.name}
              onSelect={() => {
                setHead(b.name).catch((err: unknown) => {
                  setErrorMessage(safeErrorCopy(err, 'Failed to switch variation'))
                })
              }}
              className="gap-2"
            >
              <span
                aria-hidden
                className="inline-block size-2 rounded-full"
                style={{ background: b.color }}
              />
              <span className="truncate" title={b.name}>
                {displayBranchName(b.name)}
              </span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          {createOpen ? (
            <>
              <form
                className="flex items-center gap-1 p-1"
                onSubmit={(event) => {
                  event.preventDefault()
                  void submitCreate()
                }}
              >
                <Input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="New variation name"
                  autoFocus
                  aria-label="New variation name"
                  className="h-7 text-xs"
                  maxLength={80}
                />
                <Button
                  type="submit"
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-xs"
                  disabled={!newName.trim()}
                >
                  Add
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  onClick={() => {
                    setCreateOpen(false)
                    setNewName('')
                  }}
                >
                  Cancel
                </Button>
              </form>
              {errorBanner ? <div className="px-1 pb-1">{errorBanner}</div> : null}
            </>
          ) : (
            <DropdownMenuItem
              onSelect={(event) => {
                event.preventDefault()
                setCreateOpen(true)
              }}
              className="gap-2"
            >
              <Plus className="size-3.5" />
              New variation…
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Kebab menu: rename, merge, and delete. */}
      {/* Note: DropdownMenuTrigger asChild must wrap a plain <button>. If a shadcn <Button>
          sits in between, the Radix ref never reaches the real DOM node and the popover
          can stay stuck at its initial off-screen position. */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Variation actions"
            data-testid="header-branch-kebab"
            disabled={disabled}
            className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
          >
            <MoreHorizontal className="size-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-[240px]">
          <DropdownMenuLabel className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider">
            <GitMerge className="size-3" />
            Combine into «{displayBranchName(head)}»
          </DropdownMenuLabel>
          {!mergeEnabled ? (
            <DropdownMenuItem disabled className="text-xs text-muted-foreground">
              Combine unavailable
            </DropdownMenuItem>
          ) : otherBranches.length === 0 ? (
            <DropdownMenuItem disabled className="text-xs text-muted-foreground">
              No other variations
            </DropdownMenuItem>
          ) : (
            otherBranches.map((b) => (
              <DropdownMenuItem
                key={`merge-${b.name}`}
                onSelect={() => {
                  // activeBranch can be momentarily undefined if HEAD changed
                  // but the branches list has not been refetched yet. Never
                  // open MergeDialog with a null target in that window.
                  if (!activeBranch) return
                  setPendingMerge({ source: b, target: activeBranch })
                }}
                className="gap-2"
              >
                <span
                  aria-hidden
                  className="inline-block size-2 rounded-full"
                  style={{ background: b.color }}
                />
                <span className="truncate">{displayBranchName(b.name)}</span>
              </DropdownMenuItem>
            ))
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={head === 'main'}
            onSelect={(e) => {
              e.preventDefault()
              openRename()
            }}
            className="gap-2"
          >
            <Pencil className="size-3.5 shrink-0" />
            <TruncatedMenuLabel text={`Rename «${displayBranchName(head)}»…`} />
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={head === 'main'}
            className="gap-2 text-destructive focus:text-destructive"
            onSelect={(e) => {
              e.preventDefault()
              if (activeBranch) {
                // Same stale-error hygiene as the rename flow.
                setErrorMessage(null)
                setPendingDelete(activeBranch)
              }
            }}
          >
            <Trash2 className="size-3.5 shrink-0" />
            <TruncatedMenuLabel text={`Delete «${displayBranchName(head)}»…`} />
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Rendered inline inside the create form / rename dialog while those
          surfaces are open (see errorBanner above); only fall back to this
          header-row copy once neither is open. */}
      {!createOpen && !renameOpen ? errorBanner : null}

      {/* Rename dialog */}
      <Dialog
        open={renameOpen}
        onOpenChange={(open) => {
          setRenameOpen(open)
          // A rename error must not leak into the header row after close.
          if (!open) setErrorMessage(null)
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Rename «{displayBranchName(renameTarget?.name ?? head)}»</DialogTitle>
            <DialogDescription>
              Enter a new name. Every saved version on this variation will be relinked to it.
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={renameDraft}
            onChange={(e) => setRenameDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void submitRename()
              }
            }}
            placeholder={renameTarget?.name ?? head}
            maxLength={80}
          />
          {renameOpen && errorBanner ? errorBanner : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={submitRename}
              disabled={!renameDraft.trim() || renameDraft.trim() === renameTarget?.name}
            >
              Rename
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete alert */}
      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(next) => {
          if (!next) setPendingDelete(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete «{displayBranchName(pendingDelete?.name ?? '')}»?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This deletes the variation. Saved versions stay in version history, but the variation
              will no longer be reachable from variation navigation.
              {pendingStats && pendingStats.unmergedCommits > 0 ? (
                <>
                  <br />
                  <strong className="text-destructive">
                    ⚠ {pendingStats.unmergedCommits} changes not yet combined remain
                  </strong>
                </>
              ) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleting || !pendingDelete}
              onClick={async (e) => {
                if (!pendingDelete) return
                e.preventDefault()
                setDeleting(true)
                try {
                  await deleteBranch(pendingDelete.name)
                  setErrorMessage(null)
                  setPendingDelete(null)
                } catch (err) {
                  setErrorMessage(safeErrorCopy(err, 'Failed to delete variation'))
                  setPendingDelete(null)
                } finally {
                  setDeleting(false)
                }
              }}
            >
              {deleting ? 'Deleting…' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Reuse the shared merge dialog, loaded on demand so its bundle cost
          is only paid once a merge is actually initiated. */}
      {pendingMerge !== null && (
        <Suspense fallback={null}>
          <MergeDialog
            open
            source={pendingMerge.source}
            target={pendingMerge.target}
            onClose={() => setPendingMerge(null)}
            runMerge={(source, args) => runMerge(source, args) as Promise<MergeResult>}
            workspaceId={workspaceId}
            slug={slug}
          />
        </Suspense>
      )}
    </div>
  )
}

export default HeaderBranchChip
