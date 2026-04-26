import { useEffect, useState, type JSX } from 'react'
import { ChevronDown, GitBranch, GitMerge, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react'
import { Button } from './ui/button.js'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu.js'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './ui/alert-dialog.js'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog.js'
import { Input } from './ui/input.js'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip.js'
import { cn } from '@/lib/utils'
import type { BranchMeta, MergeResult } from '../hooks/useBranches.js'
import { useBranches } from '../hooks/useBranches.js'
import { MergeDialog } from './MergeDialog.js'

// Consolidate branch operations into a single `●branch▾` chip in the header.
//
// Behavior:
//   - Left trigger: switch branches from a dropdown
//   - Right kebab: rename, delete, or merge from another branch
//   - New branch: inline form inside the dropdown
//
// Unlike the old tab layout, there is always exactly one visible chip for HEAD.
// Other branches are managed through the dropdown and kebab menu.

export interface HeaderBranchChipProps {
  workspaceId: string
  slug: string
  disabled?: boolean
}

export function HeaderBranchChip({
  workspaceId,
  slug,
  disabled,
}: HeaderBranchChipProps): JSX.Element {
  const {
    state,
    createBranch,
    deleteBranch,
    getBranchStats,
    renameBranch,
    setHead,
    merge: runMerge,
  } = useBranches(workspaceId, slug)

  const head = state.head
  const activeBranch: BranchMeta | undefined = state.branches.find((b) => b.name === head)
  const otherBranches = state.branches.filter((b) => b.name !== head)

  // Surface create/rename/delete failures through one shared inline error banner.
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const extractErrorMessage = (err: unknown, fallback: string): string => {
    if (err instanceof Error) return err.message
    if (err && typeof err === 'object') {
      const obj = err as { body?: { message?: unknown; error?: unknown } }
      if (typeof obj.body?.message === 'string') return obj.body.message
      if (typeof obj.body?.error === 'string') return obj.body.error
    }
    return fallback
  }

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
      setErrorMessage(extractErrorMessage(err, 'Failed to create branch'))
    }
  }

  // Rename state.
  const [renameOpen, setRenameOpen] = useState(false)
  const [renameDraft, setRenameDraft] = useState('')
  const openRename = () => {
    setRenameDraft(head)
    setRenameOpen(true)
  }
  const submitRename = async () => {
    const next = renameDraft.trim()
    if (!next || next === head) {
      setRenameOpen(false)
      return
    }
    try {
      await renameBranch(head, next)
      setRenameOpen(false)
      setErrorMessage(null)
    } catch (err) {
      setErrorMessage(extractErrorMessage(err, 'Failed to rename branch'))
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
  const [mergeSource, setMergeSource] = useState<BranchMeta | null>(null)
  const mergeTarget = activeBranch ?? null

  const chipColor = activeBranch?.color ?? '#64748b'

  return (
    <div className="flex items-center gap-1">
      {/* Main chip: branch switching and creation live in this dropdown. */}
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                disabled={disabled}
                aria-label={`Switch branch (current: ${head})`}
                data-testid="header-branch-chip"
                className={cn(
                  'flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium',
                  'max-w-[220px] transition-colors hover:bg-accent disabled:opacity-60',
                )}
                style={{ borderColor: chipColor, color: chipColor }}
              >
                <span aria-hidden className="inline-block size-2 shrink-0 rounded-full" style={{ background: chipColor }} />
                <span className="truncate" title={head}>{head}</span>
                <ChevronDown className="size-3 shrink-0 opacity-70" aria-hidden />
              </button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>Branch</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="start" className="w-[240px]">
          <DropdownMenuLabel className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider">
            <GitBranch className="size-3" />
            Switch branch
          </DropdownMenuLabel>
          {/* Show HEAD first and mark it as the current branch. */}
          <DropdownMenuItem
            onSelect={(e) => e.preventDefault()}
            className="gap-2"
            disabled
          >
            <span aria-hidden className="inline-block size-2 rounded-full" style={{ background: chipColor }} />
            <span className="truncate">{head}</span>
            <span className="ml-auto text-[10px] text-muted-foreground">Current</span>
          </DropdownMenuItem>
          {otherBranches.map((b) => (
            <DropdownMenuItem
              key={b.name}
              onSelect={() => {
                setHead(b.name).catch((err: unknown) => {
                  setErrorMessage(extractErrorMessage(err, 'Failed to switch branch'))
                })
              }}
              className="gap-2"
            >
              <span aria-hidden className="inline-block size-2 rounded-full" style={{ background: b.color }} />
              <span className="truncate" title={b.name}>{b.name}</span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          {createOpen ? (
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
                placeholder="New branch name"
                autoFocus
                aria-label="New branch name"
                className="h-7 text-xs"
              />
              <Button type="submit" size="sm" variant="outline" className="h-7 px-2 text-xs">
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
          ) : (
            <DropdownMenuItem
              onSelect={(event) => {
                event.preventDefault()
                setCreateOpen(true)
              }}
              className="gap-2"
            >
              <Plus className="size-3.5" />
              New branch…
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
            aria-label="Branch actions"
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
            Merge into «{head}»
          </DropdownMenuLabel>
          {otherBranches.length === 0 ? (
            <DropdownMenuItem disabled className="text-xs text-muted-foreground">
              No other branches
            </DropdownMenuItem>
          ) : (
            otherBranches.map((b) => (
              <DropdownMenuItem
                key={`merge-${b.name}`}
                onSelect={() => setMergeSource(b)}
                className="gap-2"
              >
                <span aria-hidden className="inline-block size-2 rounded-full" style={{ background: b.color }} />
                <span className="truncate">{b.name}</span>
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
            <Pencil className="size-3.5" />
            Rename «{head}»…
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={head === 'main'}
            className="gap-2 text-destructive focus:text-destructive"
            onSelect={(e) => {
              e.preventDefault()
              if (activeBranch) setPendingDelete(activeBranch)
            }}
          >
            <Trash2 className="size-3.5" />
            Delete «{head}»…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {errorMessage ? (
        <div
          role="alert"
          className="flex max-w-[200px] items-center gap-1 text-[11px] text-destructive"
        >
          <span aria-hidden>⚠</span>
          <span className="truncate" title={errorMessage}>{errorMessage}</span>
          <button
            type="button"
            className="ml-auto text-muted-foreground hover:text-foreground"
            onClick={() => setErrorMessage(null)}
            aria-label="Dismiss error"
          >
            ×
          </button>
        </div>
      ) : null}

      {/* Rename dialog */}
      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Rename «{head}»</DialogTitle>
            <DialogDescription>
              Enter a new name. Every saved version on this branch will be relinked to it.
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
            placeholder={head}
            maxLength={80}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submitRename}>Rename</Button>
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
            <AlertDialogTitle>Delete «{pendingDelete?.name ?? ''}»?</AlertDialogTitle>
            <AlertDialogDescription>
              This deletes the branch. Saved versions stay in version history, but the branch will no
              longer be reachable from branch navigation.
              {pendingStats && pendingStats.unmergedCommits > 0 ? (
                <>
                  <br />
                  <strong className="text-destructive">
                    ⚠ {pendingStats.unmergedCommits} unmerged commits remain
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
                  setErrorMessage(extractErrorMessage(err, 'Failed to delete branch'))
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

      {/* Reuse the shared merge dialog. */}
      <MergeDialog
        open={mergeSource !== null}
        source={mergeSource}
        target={mergeTarget}
        onClose={() => setMergeSource(null)}
        runMerge={(source, args) => runMerge(source, args) as Promise<MergeResult>}
        workspaceId={workspaceId}
        slug={slug}
      />
    </div>
  )
}

export default HeaderBranchChip
