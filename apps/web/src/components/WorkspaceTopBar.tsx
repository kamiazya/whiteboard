import { ChevronLeft, History, RotateCcw, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { HEADER_BUTTON_CLASS, HEADER_TOGGLE_CLASS } from '../components/ui/header-button.js'
import { Tooltip, TooltipContent, TooltipTrigger } from '../components/ui/tooltip.js'
import { useDaemonApi } from '../contexts/DaemonApiContext.js'
import { cn } from '../lib/utils.js'
import { HeaderBranchChip } from './HeaderBranchChip'
import { useDocumentNames } from './workspace-top-bar/useDocumentNames'

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

/**
 * What the bar needs to show a LOOKING-AT state. Structurally the panel's
 * `VersionPreviewSession` minus the state itself, which the bar never draws.
 */
export interface TopBarPreview {
  readonly title: string
  readonly isRestoring: boolean
  readonly error: string | null
  readonly stop: () => void
  readonly restore: () => void
}

export interface WorkspaceTopBarCapabilities {
  branches?: boolean
  merge?: boolean
}

interface Props {
  workspaceId: string
  path: string
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
  // Gates HeaderBranchChip (branches) and its mergeEnabled passthrough
  // (merge). Undefined means "all capabilities on", matching every existing
  // caller's behavior.
  capabilities?: WorkspaceTopBarCapabilities
  // Passed through to HeaderBranchChip: preview a variation without
  // switching. The page owns the address, so it owns the handler.
  onPreviewVariation?: (name: string) => void
  /**
   * Opens and closes the document's history. The PAGE owns both the state and
   * the panel: history is a column of the editor row, not a popover hanging
   * off this bar, so the bar carries only the control that asks for it.
   *
   * Omitted for a document with no history to open, which hides the control
   * rather than rendering it inert. It is deliberately NOT gated on the
   * document's kind — a markdown document's history is its keeper's business,
   * and gating it here is what left one unreachable.
   */
  onToggleHistory?: () => void
  historyOpen?: boolean
  /**
   * A past version on screen in place of the document, and the two things to
   * do about it.
   *
   * It lives HERE rather than in the history panel because the thing that
   * changed is the document: the panel is beside it on a wide screen and a
   * sheet at the far edge on a narrow one, so a person who has just replaced
   * what they are looking at would be told about it, and offered the way
   * back, in the one place they are not looking. The bar's ordinary actions
   * are hidden while this is set — every one of them acts on a document that
   * is not currently drawn.
   */
  preview?: TopBarPreview
  // Bumped by the host page on an externally observed HEAD/version change
  // (another client, an MCP tool call) so the chip/timeline refetch without
  // waiting for their own poll interval.
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
// - Only a 48px top bar; the editor keeps the full width
// - Left: back to the document browser, then the page's own title segment.
//   Naming and every per-document verb belong to that segment (the document
//   is one object, so it gets one action menu — ADR-0006), not to this bar.
// - Fullscreen is NOT here: it is the shell row's (AppShell), because its
//   subject is the app rather than the document. The "View options" kebab
//   that carried it below 400px went with it — one ⋯ per row.
//
// This bar answers "which document am I in, and what can I do to it". It
// deliberately cannot answer "which document do I want" — choosing one is
// the document browser's job, reached through the back control.

export default function WorkspaceTopBar({
  workspaceId,
  path,
  onNavigateBack,
  dataMode = 'daemon',
  capabilities,
  onPreviewVariation,
  onToggleHistory,
  historyOpen = false,
  preview,
  branchRefreshSignal,
  titleSlot,
}: Props) {
  const isLocalMode = dataMode === 'local'
  const branchesEnabled = capabilities?.branches ?? true
  const mergeEnabled = capabilities?.merge ?? true
  const daemonFetch = useDaemonApi()

  const { effectiveNames, renameDocument } = useDocumentNames({
    workspaceId,
    isLocalMode,
    daemonFetch,
  })

  const canvasCustomName = effectiveNames.documents[path]

  if (preview !== undefined) {
    return (
      <header
        data-testid="version-preview-bar"
        className="relative z-30 flex h-12 shrink-0 items-center gap-2 border-b border-primary/40 bg-primary/5 px-3"
      >
        <span className="min-w-0 flex-1 leading-tight">
          <b className="block truncate text-sm font-medium">Viewing {preview.title}</b>
          {preview.error === null ? (
            <span className="text-[11px] text-muted-foreground">read-only</span>
          ) : (
            <span role="alert" className="text-[11px] text-destructive">
              {preview.error}
            </span>
          )}
        </span>
        {/* Native `disabled` on both: neither carries a tooltip to keep
            alive, and an in-flight restore is exactly the state a pointer
            should bounce off rather than queue behind. Stopping mid-restore
            would put the live document back while the past state is still
            landing on it. */}
        <button
          type="button"
          aria-label="Stop viewing"
          disabled={preview.isRestoring}
          onClick={preview.stop}
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
        >
          <X aria-hidden="true" className="size-4" />
        </button>
        {/* The heavier of the two, so it carries the weight — a pair of
            identical round buttons would say the acts are alike. */}
        <button
          type="button"
          aria-label="Restore this version"
          disabled={preview.isRestoring}
          onClick={preview.restore}
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          <RotateCcw
            aria-hidden="true"
            className={cn('size-4', preview.isRestoring && 'animate-spin')}
          />
        </button>
      </header>
    )
  }

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
                className={HEADER_BUTTON_CLASS}
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
              onPreviewVariation={onPreviewVariation}
            />
          </>
        )}

        {/* The document's history. Kind-agnostic on purpose — see the prop. */}
        {onToggleHistory && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="History"
                aria-expanded={historyOpen}
                onClick={onToggleHistory}
                className={HEADER_TOGGLE_CLASS}
              >
                <History aria-hidden="true" className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent>History</TooltipContent>
          </Tooltip>
        )}
      </div>
    </header>
  )
}
