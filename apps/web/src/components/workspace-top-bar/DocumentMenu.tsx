import { Check, Copy, Download, EllipsisVertical } from 'lucide-react'
import type { ReactNode, RefObject } from 'react'
import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { SceneExportFormat } from '@/hooks/useDocumentSync'
import type { AppLogger } from '@/lib/app-logger'
import { useCopyDocumentUrl } from './useCopyDocumentUrl'

interface DocumentMenuProps {
  /**
   * The address to hand out for the open document. Built by the PAGE, not by
   * the header: browser-local documents live at `/local/:path` and daemon
   * documents at `/w/:workspaceId/document/*`, and the header cannot tell
   * which shape applies without knowing the backend it is mounted over.
   */
  readonly documentUrl: string
  /**
   * Already-wrapped export handler (the page owns the download and its error
   * state through `useSceneExport`). Omitted hides the export entries rather
   * than wiring controls to a capability the page has not set up.
   */
  readonly onExport?: (format: SceneExportFormat) => void
  /**
   * Lets a page's own dialog return focus to this trigger on close — the
   * menu item that opened it unmounted with the menu, so the default
   * close-focus would fall to `<body>`.
   */
  readonly triggerRef?: RefObject<HTMLButtonElement | null>
  /**
   * The page's own entries (duplicate, delete, format-specific copies),
   * rendered after the shared ones. Pages end with their destructive entry,
   * which keeps the catalog's band order (verbs, then destructive alone at
   * the bottom) without this component having to police it.
   */
  readonly children?: ReactNode
  readonly log?: AppLogger
}

/**
 * The ONE action menu for the open document.
 *
 * There used to be two, a header apart: a pencil owning rename/copy/export
 * and this kebab owning export/duplicate/delete. Export sat in both, and
 * because only the daemon page wired an export handler, the same pencil icon
 * opened a different menu depending on the backend. ADR-0006 puts per-object
 * actions on the object, and the open document is one object.
 *
 * Rename is deliberately absent: naming happens in place on the title field
 * (ADR-0006 point 3), and changing a document's PATH as well as its name is
 * the document browser's Rename dialog, where the tree the move affects is
 * visible.
 */
export function DocumentMenu({
  documentUrl,
  onExport,
  triggerRef,
  children,
  log,
}: DocumentMenuProps) {
  // Anchor for the portaled copy-error fallback below — once portaled to
  // document.body it can no longer position itself against this wrapper with
  // CSS, so its on-screen position is computed from this element's rect.
  const wrapperRef = useRef<HTMLDivElement | null>(null)

  // Re-armed on every setup so React StrictMode's dev-only double-invoke
  // (setup -> cleanup -> setup) doesn't leave this permanently false and
  // silently stop the copy status from ever being reported.
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const { copyStatus, copyDocumentUrl, resetCopyStatus } = useCopyDocumentUrl(
    documentUrl,
    log,
    mountedRef,
  )

  return (
    <div ref={wrapperRef} className="relative">
      <DropdownMenu
        onOpenChange={(open) => {
          // Every fresh open starts from a clean confirmation state rather
          // than showing a stale "Copied!"/error from a previous visit.
          if (open) resetCopyStatus()
        }}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                ref={triggerRef}
                type="button"
                aria-label="More actions"
                variant="ghost"
                size="sm"
                className="size-7 p-0"
              >
                <EllipsisVertical aria-hidden="true" className="size-4" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>More actions</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onSelect={(event) => {
              // Keep the menu open so the "Copied!"/error confirmation is
              // actually visible — Radix closes on select by default, which
              // is exactly the silent-feedback bug.
              event.preventDefault()
              void copyDocumentUrl()
            }}
            className="gap-2"
          >
            {copyStatus === 'copied' ? (
              <Check aria-hidden="true" className="size-3.5 text-emerald-600" />
            ) : (
              <Copy aria-hidden="true" className="size-3.5" />
            )}
            {copyStatus === 'copied' ? 'Copied!' : 'Copy link'}
          </DropdownMenuItem>
          {onExport && (
            <>
              <DropdownMenuItem onSelect={() => onExport('png')} className="gap-2">
                <Download aria-hidden="true" className="size-3.5" />
                Export as PNG
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onExport('svg')} className="gap-2">
                <Download aria-hidden="true" className="size-3.5" />
                Export as SVG
              </DropdownMenuItem>
            </>
          )}
          {children}
        </DropdownMenuContent>
      </DropdownMenu>
      {/* Both the live-region announcement and the error fallback below are
          portaled straight to document.body rather than rendered as siblings
          in this subtree, for two independent reasons:
          1. WAI-ARIA menu pattern: an element with role="menu" may only own
             menuitem/menuitemcheckbox/menuitemradio/group descendants, so
             neither can live inside the Radix menu content (axe/AccessLint:
             aria-required-children).
          2. The copy handler above deliberately keeps this menu open on both
             success and failure so the confirmation is visible, and Radix's
             DismissableLayer inerts (aria-hides) the rest of the page for as
             long as it stays open. Rendering these two as ordinary siblings
             here — i.e. nested under the page's own <header>/<main> — meant
             their on-again-off-again presence changed *which* ancestor chain
             that inerting walk kept visible on every open/close, which went
             on to corrupt the hide/unhide bookkeeping for unrelated siblings
             elsewhere on the page. Portaling both directly to body gives each
             an ancestor chain of just `document.body`, so they can never
             again be nested inside — or, by omission, un-inert — any of the
             page's own DOM. */}
      {typeof document !== 'undefined' &&
        createPortal(
          <div aria-live="polite" role="status" aria-label="Copy status" className="sr-only">
            {copyStatus === 'copied' && 'Document link copied to clipboard.'}
            {copyStatus === 'error' && "Couldn't copy the document link automatically."}
          </div>,
          document.body,
        )}
      {typeof document !== 'undefined' &&
        copyStatus === 'error' &&
        createPortal(
          <div
            role="alert"
            style={(() => {
              const rect = wrapperRef.current?.getBoundingClientRect()
              return {
                position: 'fixed',
                top: (rect?.bottom ?? 0) + 4,
                left: rect?.left ?? 0,
              }
            })()}
            className="z-50 w-72 rounded-md border bg-popover px-2 py-1.5 text-xs text-destructive shadow-md"
          >
            <p>Couldn't copy automatically. Select and copy the link below:</p>
            <Input
              readOnly
              value={documentUrl}
              onClick={(event) => {
                event.stopPropagation()
                event.currentTarget.select()
              }}
              onFocus={(event) => event.currentTarget.select()}
              aria-label="Document link"
              className="mt-1 h-7 font-mono text-[11px]"
            />
          </div>,
          document.body,
        )}
    </div>
  )
}
