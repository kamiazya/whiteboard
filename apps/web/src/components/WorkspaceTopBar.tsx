import { ChevronLeft } from 'lucide-react'
import type { ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useDaemonApi } from '@/contexts/DaemonApiContext'
import { useDirtyState } from '@/hooks/useDirtyState'
import { getAppLogger } from '@/lib/app-logger'
import { HeaderBranchChip } from './HeaderBranchChip'
import { HeaderSaveDot } from './HeaderSaveDot'
import { DocumentDropdown } from './workspace-top-bar/DocumentDropdown'
import { TopBarSecondaryActions } from './workspace-top-bar/TopBarSecondaryActions'
import type { DocumentInfo } from './workspace-top-bar/types'
import { useCreateDocument } from './workspace-top-bar/useCreateDocument'
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
  documents: DocumentInfo[]
  getThumbnailBlob?: () => Promise<Blob | null>
  // apps/web has no react-router-dom; the page owns navigation and passes it
  // in as callbacks instead of the original Link/useNavigate. Omitted when
  // the host page has no "back" destination (e.g. a daemon page with no
  // canvas-list route) — the button is hidden rather than rendered inert.
  onNavigateBack?: () => void
  onNavigateToDocument: (path: string) => void
  // Defaults to 'daemon' so every existing caller keeps fetching /names and
  // POSTing renames/new-canvas unchanged. 'local' is for hosts with no
  // daemon data layer (browser-local): the names fetch never fires, display
  // names come from documents[].name, and create routes through
  // onCreateDocument. Naming is the page's title segment either way.
  dataMode?: 'daemon' | 'local'
  onCreateDocument?: () => void | Promise<void>
  /** Local mode only for now: creates a markdown-kind canvas and opens it. */
  onCreateMarkdownCanvas?: () => void | Promise<void>
  // Omitted when the host page has no fullscreen affordance of its own.
  onToggleFullscreen?: () => void
  isFullscreen?: boolean
  // Gates HeaderSaveDot/Cmd+S/History (versions), HeaderBranchChip (branches),
  // and HeaderBranchChip's mergeEnabled passthrough (merge). Undefined means
  // "all capabilities on", matching every existing caller's behavior.
  capabilities?: WorkspaceTopBarCapabilities
  // Bumped by the host page on an externally observed HEAD/version change
  // (another client, an MCP tool call) so the chip/timeline refetch without
  // waiting for their own poll interval.
  branchRefreshSignal?: number
  // Right-side slot ahead of the secondary actions — the host page's
  // connection-state chip mounts here so the one
  // status affordance lives in the header instead of a banner row.
  statusSlot?: ReactNode
  /**
   * The merged canvas row's flexible middle (title + properties triggers),
   * provided by the page — the header is one row, so pages inject their
   * canvas identity here instead of stacking a second chrome strip.
   *
   * A FUNCTION rather than a node because the display NAME lives here, not
   * in the page: this bar already loads `/names` for the canvas dropdown, so
   * a page that rendered its own identity would either duplicate that fetch
   * or invent a second source for the same value. Passing the name down is
   * what lets `apps/web`'s two pages agree that a document is named by its
   * workspace (ADR-0009 decision 2) rather than by its content.
   */
  titleSlot?: (identity: DocumentIdentity) => ReactNode
  // Pass-through to DocumentDropdown's optional Workspaces section — both
  // omitted (every pre-existing caller) keeps this byte-identical.
  workspaces?: string[]
  onSwitchWorkspace?: (workspaceId: string) => void
}

// Give the canvas visual priority and keep the surrounding chrome lightweight.
// - Only a 48px top bar; Excalidraw keeps the full width
// - Left: back to workspace, the canvas switcher, and the page's own title
//   segment. Naming and every per-document verb belong to that segment (the
//   document is one object, so it gets one action menu — ADR-0006), not to
//   this bar.
// - Right: version history and fullscreen. Below 400px these secondary
//   actions collapse into a "View options" kebab so the header never wraps.
// - More complex lists appear on demand through buttons and popovers

export default function WorkspaceTopBar({
  workspaceId,
  path,
  documents,
  onToggleFullscreen,
  isFullscreen,
  getThumbnailBlob,
  onNavigateBack,
  onNavigateToDocument,
  dataMode = 'daemon',
  onCreateDocument,
  onCreateMarkdownCanvas,
  capabilities,
  branchRefreshSignal,
  statusSlot,
  titleSlot,
  workspaces,
  onSwitchWorkspace,
}: Props) {
  const isLocalMode = dataMode === 'local'
  const versionsEnabled = capabilities?.versions ?? true
  const branchesEnabled = capabilities?.branches ?? true
  const mergeEnabled = capabilities?.merge ?? true
  const log = getAppLogger('workspace-top-bar')
  const daemonFetch = useDaemonApi()

  const { effectiveNames, renameDocument, togglePin } = useDocumentNames({
    workspaceId,
    documents,
    isLocalMode,
    daemonFetch,
  })

  const [documentSearch, setDocumentSearch] = useState('')

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
    daemonFetch,
    getThumbnailBlob,
    log,
  })
  useQuickSaveShortcut(versionsEnabled, saveVersion)
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform)
  const shortcutHint = isMac ? '⌘S' : 'Ctrl+S'

  // Guards useCreateDocument's async callback against setState-after-unmount
  // when a canvas switch/delete resolves mid-flight.
  const mountedRef = useRef(true)
  useEffect(() => {
    // Re-arm on every setup so React StrictMode's dev-only double-invoke
    // (setup -> cleanup -> setup) doesn't leave this permanently false
    // after the first synthetic unmount/remount.
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const canvasCustomName = effectiveNames.documents[path]

  const { newDocumentError, newDocumentBusy, openNewDocument } = useCreateDocument({
    workspaceId,
    documents,
    path,
    isLocalMode,
    onCreateDocument,
    onNavigateToDocument,
    daemonFetch,
    mountedRef,
  })

  return (
    <header className="relative z-30 flex h-12 shrink-0 items-center justify-between gap-3 border-b bg-background px-3">
      {/* Left side: back button, workspace name, and canvas switcher. */}
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

        <DocumentDropdown
          workspaceId={workspaceId}
          path={path}
          documents={documents}
          effectiveNames={effectiveNames}
          isLocalMode={isLocalMode}
          documentSearch={documentSearch}
          onCanvasSearchChange={setDocumentSearch}
          onNavigateToDocument={onNavigateToDocument}
          onTogglePin={togglePin}
          onOpenNewCanvas={openNewDocument}
          onCreateMarkdown={
            onCreateMarkdownCanvas === undefined ? undefined : () => void onCreateMarkdownCanvas()
          }
          workspaces={workspaces}
          onSwitchWorkspace={onSwitchWorkspace}
        />

        {/* Both modes: immediate create has no dialog, so its in-flight and
            failure states render here beside the switcher. The status line
            replaces the deleted dialog's disabled "Creating…" button as the
            flow's announced busy indication (accessibility criterion 5). */}
        {/* Mounted even while silent: a polite region that arrives already
            carrying its message is announced inconsistently, so this one is
            always here and only its text changes.
            `sr-only` rather than a `hidden` class while idle — display:none
            would prune it from the accessibility tree, which is the same bug
            with a stylesheet instead of a conditional. sr-only is absolutely
            positioned, so an empty region also adds no gap to this flex row. */}
        <span
          aria-live="polite"
          role="status"
          aria-label="New canvas status"
          className={newDocumentBusy ? 'text-xs text-muted-foreground' : 'sr-only'}
        >
          {newDocumentBusy ? 'Creating canvas…' : ''}
        </span>
        {newDocumentError && (
          <span className="truncate text-xs text-destructive" role="alert">
            {newDocumentError}
          </span>
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
          <HeaderSaveDot
            dirty={isDirty}
            saving={saving}
            onSave={() => void saveVersion('')}
            shortcutHint={shortcutHint}
          />
        )}
      </div>

      {statusSlot}
      <TopBarSecondaryActions onToggleFullscreen={onToggleFullscreen} isFullscreen={isFullscreen} />
    </header>
  )
}
