import { ChevronLeft } from 'lucide-react'
import type { ReactNode } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useDaemonApi } from '@/contexts/DaemonApiContext'
import { useDirtyState } from '@/hooks/useDirtyState'
import { getAppLogger } from '@/lib/app-logger'
import { isMacPlatform } from '../lib/platform.js'
import { HeaderBranchChip } from './HeaderBranchChip'
import { HeaderVersionDot } from './HeaderVersionDot'
import { TopBarSecondaryActions } from './workspace-top-bar/TopBarSecondaryActions'
import { useDocumentNames } from './workspace-top-bar/useDocumentNames'
import { useQuickSaveShortcut, useSaveVersion } from './workspace-top-bar/useSaveVersion'

// Gates which pieces of daemon-only chrome render. Omitted entirely (the
// default), every capability behaves as if it were `true` — this keeps every
// pre-existing caller (all of which never pass `capabilities`) byte-identical.
/** What the top bar knows about the open document's NAME, handed to `titleSlot`. */
export interface DocumentIdentity {
  /** The workspace's display name, falling back to the path when none is stored. */
  readonly name: string
  /**
   * Commits a new display name. Absent in local mode, where the host page
   * owns renaming through its own store rather than through `/names`.
   */
  readonly onRename?: (next: string) => void
}

export interface WorkspaceTopBarCapabilities {
  versions?: boolean
  branches?: boolean
  merge?: boolean
}

interface Props {
  workspaceId: string
  path: string
  getThumbnailBlob?: () => Promise<Blob | null>
  /**
   * Leaves the document for the document browser, which is where finding one
   * happens (user decision 2026-08-22). apps/web has no react-router-dom
   * here, so the page owns the navigation and passes it in. Omitted only by
   * hosts with no browser route to return to — the control is hidden rather
   * than rendered inert.
   */
  onNavigateBack?: () => void
  /**
   * 'local' is for hosts with no daemon data layer (the browser keeper): the
   * `/names` fetch never fires and the page's title segment owns naming.
   * Defaults to 'daemon' so every existing caller keeps fetching `/names`.
   */
  dataMode?: 'daemon' | 'local'
  // Omitted when the host page has no fullscreen affordance of its own.
  onToggleFullscreen?: () => void
  isFullscreen?: boolean
  // Gates HeaderVersionDot/Cmd+S/History (versions), HeaderBranchChip (branches),
  // and HeaderBranchChip's mergeEnabled passthrough (merge). Undefined means
  // "all capabilities on", matching every existing caller's behavior.
  capabilities?: WorkspaceTopBarCapabilities
  // Bumped by the host page on an externally observed HEAD/version change
  // (another client, an MCP tool call) so the chip/timeline refetch without
  // waiting for their own poll interval.
  branchRefreshSignal?: number
  /**
   * The merged canvas row's flexible middle (title + properties triggers),
   * provided by the page — the header is one row, so pages inject their
   * canvas identity here instead of stacking a second chrome strip.
   *
   * A FUNCTION rather than a node because the display NAME lives here, not
   * in the page: this bar already loads `/names`, so a page that rendered its
   * own identity would either duplicate that fetch or invent a second source
   * for the same value. Passing the name down is
   * what lets `apps/web`'s two pages agree that a document is named by its
   * workspace (ADR-0009 decision 2) rather than by its content.
   */
  titleSlot?: (identity: DocumentIdentity) => ReactNode
}

// Give the canvas visual priority and keep the surrounding chrome lightweight.
// - Only a 48px top bar; Excalidraw keeps the full width
// - Left: back to the document browser, then the page's own title segment.
//   Naming and every per-document verb belong to that segment (the document
//   is one object, so it gets one action menu — ADR-0006), not to this bar.
// - Right: version history and fullscreen. Below 400px these secondary
//   actions collapse into a "View options" kebab so the header never wraps.
//
// This bar answers "which document am I in, and what can I do to it". It
// deliberately cannot answer "which document do I want" — choosing one is
// the document browser's job, reached through the back control.

export default function WorkspaceTopBar({
  workspaceId,
  path,
  onToggleFullscreen,
  isFullscreen,
  getThumbnailBlob,
  onNavigateBack,
  dataMode = 'daemon',
  capabilities,
  branchRefreshSignal,
  titleSlot,
}: Props) {
  const isLocalMode = dataMode === 'local'
  const versionsEnabled = capabilities?.versions ?? true
  const branchesEnabled = capabilities?.branches ?? true
  const mergeEnabled = capabilities?.merge ?? true
  const log = getAppLogger('workspace-top-bar')
  const daemonFetch = useDaemonApi()

  const { effectiveNames, renameDocument } = useDocumentNames({
    workspaceId,
    isLocalMode,
    daemonFetch,
  })

  // Save state: dirty dot + Cmd/Ctrl+S only.
  // No beforeunload guard: every Excalidraw edit flows through useWhiteboardSync
  // → LoroDoc → WebSocket → daemon → SQLite blob in real time, so closing the
  // tab cannot lose persisted content. The dirty dot here only tracks
  // "haven't named a manual version yet"; warning the user about it via the
  // browser's leave-confirmation dialog is misleading and was getting in the
  // way of automation (e.g. Playwright workflows).
  const { isDirty } = useDirtyState(workspaceId, path)
  const { saving, saveVersion } = useSaveVersion({
    workspaceId,
    path,
    getThumbnailBlob,
    log,
  })
  useQuickSaveShortcut(versionsEnabled, saveVersion)
  const isMac = isMacPlatform()
  const shortcutHint = isMac ? '⌘S' : 'Ctrl+S'

  const canvasCustomName = effectiveNames.documents[path]

  return (
    <header className="relative z-30 flex h-12 shrink-0 items-center justify-between gap-3 border-b bg-background px-3">
      {/* Left side: the way out, then the page's title segment. */}
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {onNavigateBack && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onNavigateBack}
                aria-label="Back to documents"
                className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <ChevronLeft className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Back to documents</TooltipContent>
          </Tooltip>
        )}

        {titleSlot?.({
          name: canvasCustomName ?? path,
          ...(isLocalMode ? {} : { onRename: (next: string) => void renameDocument(path, next) }),
        })}

        {/* Branch chip with switch, create, rename, delete, and merge actions.
            This is the top bar's only destructive control (branch delete,
            confirmed via AlertDialog inside HeaderBranchChip); it stays in
            this left-side group and is not part of the <400px collapse. */}
        {branchesEnabled && (
          <>
            <span className="mx-1 hidden h-4 w-px bg-border sm:inline-block" aria-hidden />
            <HeaderBranchChip
              workspaceId={workspaceId}
              path={path}
              refreshSignal={branchRefreshSignal}
              mergeEnabled={mergeEnabled}
            />
          </>
        )}

        {/* Save-state dot. */}
        {versionsEnabled && (
          <HeaderVersionDot
            dirty={isDirty}
            saving={saving}
            onSave={() => void saveVersion('')}
            shortcutHint={shortcutHint}
          />
        )}
      </div>

      <TopBarSecondaryActions onToggleFullscreen={onToggleFullscreen} isFullscreen={isFullscreen} />
    </header>
  )
}
