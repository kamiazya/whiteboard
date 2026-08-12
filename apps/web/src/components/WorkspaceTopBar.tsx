import { ChevronLeft } from 'lucide-react'
import type { ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useDaemonApi } from '@/contexts/DaemonApiContext'
import type { SceneExportFormat } from '@/hooks/useCanvasSync'
import { useDirtyState } from '@/hooks/useDirtyState'
import { getAppLogger } from '@/lib/app-logger'
import HomeMark from '../brand/home-mark.svg?react'
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
export interface WorkspaceTopBarCapabilities {
  versions?: boolean
  branches?: boolean
  merge?: boolean
}

interface Props {
  workspaceId: string
  slug: string
  canvases: CanvasInfo[]
  getThumbnailBlob?: () => Promise<Blob | null>
  // apps/web has no react-router-dom; the page owns navigation and passes it
  // in as callbacks instead of the original Link/useNavigate. Omitted when
  // the host page has no "back" destination (e.g. a daemon page with no
  // canvas-list route) — the button is hidden rather than rendered inert.
  onNavigateBack?: () => void
  onNavigateToCanvas: (slug: string) => void
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
  onOpenSettings?: () => void
  /** Renders the brand mark as a go-home affordance when provided. */
  onNavigateHome?: () => void
  // Right-side slot ahead of the secondary actions — the host page's
  // connection-state chip mounts here so the one
  // status affordance lives in the header instead of a banner row.
  statusSlot?: ReactNode
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
  slug,
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
  onOpenSettings,
  onNavigateHome,
  statusSlot,
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
  const { isDirty } = useDirtyState(workspaceId, slug)
  const { saving, saveVersion } = useSaveVersion({
    workspaceId,
    slug,
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

  const canvasCustomName = effectiveNames.canvases[slug]
  // Prefer the custom name when present; otherwise split the slug into prefix and leaf.
  // Muting the prefix helps show that nearby canvases belong to the same group.
  const slashIndex = slug.indexOf('/')
  const canvasPrefix = !canvasCustomName && slashIndex !== -1 ? slug.slice(0, slashIndex) : null
  const canvasLeaf = !canvasCustomName && slashIndex !== -1 ? slug.slice(slashIndex + 1) : null
  const canvasFlat = canvasCustomName ?? (canvasPrefix === null ? slug : null)

  const {
    renamingCanvas,
    draft,
    setDraft,
    renameError,
    startRename,
    commitCanvasName,
    cancelRename,
  } = useCanvasRename({
    slug,
    isLocalMode,
    currentName: canvasCustomName,
    onRenameCanvas,
    renameCanvas,
    mountedRef,
  })

  const { newCanvasError, newCanvasBusy, openNewCanvas } = useCreateCanvas({
    workspaceId,
    canvases,
    slug,
    isLocalMode,
    onCreateCanvas,
    onNavigateToCanvas,
    daemonFetch,
    mountedRef,
  })

  // Kept outside copyCanvasUrl so the failure-path fallback can render the
  // same URL as selectable text without recomputing it.
  const canvasUrl = `${window.location.origin}/canvas/${workspaceId}/${encodeURIComponent(slug)}`
  const { copyStatus, copyCanvasUrl, resetCopyStatus } = useCopyCanvasUrl(
    canvasUrl,
    log,
    mountedRef,
  )

  // A trailing slash-segment (the canvas leaf) makes the safest download
  // filename; falling back to the raw slug covers the ungrouped case.
  const exportFilenameBase = sanitizeExportFilenameBase(canvasFlat ?? canvasLeaf ?? slug)
  const { exportError, handleExport } = useSceneExport({
    onExport,
    filenameBase: exportFilenameBase,
    log,
  })

  return (
    <header className="relative z-30 flex h-12 shrink-0 items-center justify-between gap-3 border-b bg-background px-3">
      {/* Left side: back button, workspace name, and canvas switcher. */}
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {onNavigateHome && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onNavigateHome}
                aria-label="Home"
                className="shrink-0 rounded-md p-1 text-foreground/70 hover:bg-accent hover:text-foreground"
              >
                <HomeMark className="h-[18px] w-7" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Home</TooltipContent>
          </Tooltip>
        )}
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
          slug={slug}
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
              placeholder={slug}
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
        {newCanvasBusy && (
          <span aria-live="polite" role="status" className="text-xs text-muted-foreground">
            Creating canvas…
          </span>
        )}
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

        {/* Branch chip with switch, create, rename, delete, and merge actions.
            This is the top bar's only destructive control (branch delete,
            confirmed via AlertDialog inside HeaderBranchChip); it stays in
            this left-side group and is not part of the <400px collapse. */}
        {branchesEnabled && (
          <>
            <span className="mx-1 hidden h-4 w-px bg-border sm:inline-block" aria-hidden />
            <HeaderBranchChip
              workspaceId={workspaceId}
              slug={slug}
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
      <TopBarSecondaryActions
        onToggleFullscreen={onToggleFullscreen}
        isFullscreen={isFullscreen}
        onOpenSettings={onOpenSettings}
      />
    </header>
  )
}
