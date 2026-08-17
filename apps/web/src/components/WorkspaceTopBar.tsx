import { ChevronLeft } from 'lucide-react'
import type { ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useDaemonApi } from '@/contexts/DaemonApiContext'
import { useDirtyState } from '@/hooks/useDirtyState'
import type { SceneExportFormat } from '@/hooks/useDocumentSync'
import { getAppLogger } from '@/lib/app-logger'
import { canvasPath } from '../lib/app-routes.js'
import { HeaderBranchChip } from './HeaderBranchChip'
import { HeaderSaveDot } from './HeaderSaveDot'
import { CanvasActionsMenu } from './workspace-top-bar/CanvasActionsMenu'
import { CanvasDropdown } from './workspace-top-bar/CanvasDropdown'
import { sanitizeExportFilenameBase } from './workspace-top-bar/export-filename'
import { TopBarSecondaryActions } from './workspace-top-bar/TopBarSecondaryActions'
import type { CanvasInfo } from './workspace-top-bar/types'
import { useCanvasNames } from './workspace-top-bar/useCanvasNames'
import { useCanvasRename } from './workspace-top-bar/useCanvasRename'
import { useCopyCanvasUrl } from './workspace-top-bar/useCopyCanvasUrl'
import { useCreateCanvas } from './workspace-top-bar/useCreateCanvas'
import { useQuickSaveShortcut, useSaveVersion } from './workspace-top-bar/useSaveVersion'
import { useSceneExport } from './workspace-top-bar/useSceneExport'

// Gates which pieces of daemon-only chrome render. Omitted entirely (the
// default), every capability behaves as if it were `true` — this keeps every
// pre-existing caller (all of which never pass `capabilities`) byte-identical.
/** What the top bar knows about the open document's NAME, handed to `titleSlot`. */
export interface CanvasIdentity {
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
  canvases: CanvasInfo[]
  getThumbnailBlob?: () => Promise<Blob | null>
  // apps/web has no react-router-dom; the page owns navigation and passes it
  // in as callbacks instead of the original Link/useNavigate. Omitted when
  // the host page has no "back" destination (e.g. a daemon page with no
  // canvas-list route) — the button is hidden rather than rendered inert.
  onNavigateBack?: () => void
  onNavigateToCanvas: (path: string) => void
  // Defaults to 'daemon' so every existing caller keeps fetching /names and
  // POSTing renames/new-canvas unchanged. 'local' is for hosts with no
  // daemon data layer (browser-local): the names fetch never fires and
  // rename/create route through onRenameCanvas/onCreateCanvas instead.
  dataMode?: 'daemon' | 'local'
  // Required in local mode; ignored in daemon mode. Awaited internally with
  // an unmount guard — rejections are not swallowed.
  onRenameCanvas?: (name: string) => void | Promise<void>
  onCreateCanvas?: () => void | Promise<void>
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
  // Renders the scene through the same export utility Excalidraw's own
  // (harder-to-discover) hamburger-menu export dialog uses. Omitted (the
  // default) hides the "Export as PNG/SVG/JSON" menu items entirely rather
  // than wiring a control to a capability the host page hasn't set up —
  // there is deliberately no PDF option here because no export path (this
  // app's or Excalidraw's own) produces one.
  onExport?: (format: SceneExportFormat) => Promise<Blob | null>

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
  titleSlot?: (identity: CanvasIdentity) => ReactNode
  // Pass-through to CanvasDropdown's optional Workspaces section — both
  // omitted (every pre-existing caller) keeps this byte-identical.
  workspaces?: string[]
  onSwitchWorkspace?: (workspaceId: string) => void
}

// Give the canvas visual priority and keep the surrounding chrome lightweight.
// - Only a 48px top bar; Excalidraw keeps the full width
// - Left: back to workspace, inline workspace rename, and the canvas switcher
// - Right: version history, fullscreen, and canvas rename actions. Below
//   400px these secondary actions collapse into a "More actions" kebab so
//   the header never wraps.
// - More complex lists appear on demand through buttons and popovers

export default function WorkspaceTopBar({
  workspaceId,
  path,
  canvases,
  onToggleFullscreen,
  isFullscreen,
  getThumbnailBlob,
  onNavigateBack,
  onNavigateToCanvas,
  dataMode = 'daemon',
  onRenameCanvas,
  onCreateCanvas,
  onCreateMarkdownCanvas,
  capabilities,
  branchRefreshSignal,
  onExport,
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

  const { effectiveNames, renameCanvas, togglePin } = useCanvasNames({
    workspaceId,
    canvases,
    isLocalMode,
    daemonFetch,
  })

  const [canvasSearch, setCanvasSearch] = useState('')

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

  // Guards async callbacks (onRenameCanvas/onCreateCanvas/clipboard writes)
  // against setState-after-unmount when a canvas switch/delete resolves
  // mid-flight. Shared by useCanvasRename, useCreateCanvas, and
  // useCopyCanvasUrl below.
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

  const canvasCustomName = effectiveNames.canvases[path]
  // Prefer the custom name when present; otherwise split the path into prefix and leaf.
  // Muting the prefix helps show that nearby canvases belong to the same group.
  const slashIndex = path.indexOf('/')
  const canvasPrefix = !canvasCustomName && slashIndex !== -1 ? path.slice(0, slashIndex) : null
  const canvasLeaf = !canvasCustomName && slashIndex !== -1 ? path.slice(slashIndex + 1) : null
  const canvasFlat = canvasCustomName ?? (canvasPrefix === null ? path : null)

  const {
    renamingCanvas,
    draft,
    setDraft,
    renameError,
    startRename,
    commitCanvasName,
    cancelRename,
  } = useCanvasRename({
    path,
    isLocalMode,
    currentName: canvasCustomName,
    onRenameCanvas,
    renameCanvas,
    mountedRef,
  })

  const { newCanvasError, newCanvasBusy, openNewCanvas } = useCreateCanvas({
    workspaceId,
    canvases,
    path,
    isLocalMode,
    onCreateCanvas,
    onNavigateToCanvas,
    daemonFetch,
    mountedRef,
  })

  // Kept outside copyCanvasUrl so the failure-path fallback can render the
  // same URL as selectable text without recomputing it.
  const canvasUrl = `${window.location.origin}${canvasPath(workspaceId, path)}`
  const { copyStatus, copyCanvasUrl, resetCopyStatus } = useCopyCanvasUrl(
    canvasUrl,
    log,
    mountedRef,
  )

  // A trailing slash-segment (the canvas leaf) makes the safest download
  // filename; falling back to the raw path covers the ungrouped case.
  const exportFilenameBase = sanitizeExportFilenameBase(canvasFlat ?? canvasLeaf ?? path)
  const { exportError, handleExport } = useSceneExport({
    onExport,
    filenameBase: exportFilenameBase,
    log,
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
                aria-label="Back to canvas list"
                className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <ChevronLeft className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Back to canvas list</TooltipContent>
          </Tooltip>
        )}

        <CanvasDropdown
          workspaceId={workspaceId}
          path={path}
          canvases={canvases}
          effectiveNames={effectiveNames}
          isLocalMode={isLocalMode}
          canvasSearch={canvasSearch}
          onCanvasSearchChange={setCanvasSearch}
          onNavigateToCanvas={onNavigateToCanvas}
          onTogglePin={togglePin}
          onOpenNewCanvas={openNewCanvas}
          onCreateMarkdown={
            onCreateMarkdownCanvas === undefined ? undefined : () => void onCreateMarkdownCanvas()
          }
          workspaces={workspaces}
          onSwitchWorkspace={onSwitchWorkspace}
        />

        {/* Canvas-specific actions such as rename and copy URL. */}
        <CanvasActionsMenu
          canvasUrl={canvasUrl}
          copyStatus={copyStatus}
          onCopyCanvasUrl={() => void copyCanvasUrl()}
          onResetCopyStatus={resetCopyStatus}
          onStartRename={startRename}
          onExport={onExport ? (format) => void handleExport(format) : undefined}
        />

        {/* Inline canvas rename input. */}
        {renamingCanvas && (
          <div className="flex min-w-0 flex-col gap-0.5">
            <Input
              autoFocus
              aria-label="Canvas title"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitCanvasName}
              // Excalidraw registers document-level keyboard shortcuts (Delete,
              // Backspace, etc.) that must never fire while the user is typing
              // a canvas name here.
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter') commitCanvasName()
                else if (e.key === 'Escape') cancelRename()
              }}
              onKeyUp={(e) => e.stopPropagation()}
              placeholder={path}
              className="h-7 max-w-[220px] text-sm"
            />
            {renameError && (
              <span className="truncate text-xs text-destructive" role="alert">
                {renameError}
              </span>
            )}
          </div>
        )}

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
          className={newCanvasBusy ? 'text-xs text-muted-foreground' : 'sr-only'}
        >
          {newCanvasBusy ? 'Creating canvas…' : ''}
        </span>
        {newCanvasError && (
          <span className="truncate text-xs text-destructive" role="alert">
            {newCanvasError}
          </span>
        )}

        {/* Export is a plain dropdown action with no dialog of its own, so a
            failed or unavailable export is surfaced here instead. */}
        {exportError && (
          <span className="truncate text-xs text-destructive" role="alert">
            {exportError}
          </span>
        )}

        {titleSlot?.({
          name: canvasCustomName ?? path,
          ...(isLocalMode ? {} : { onRename: (next: string) => void renameCanvas(path, next) }),
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
