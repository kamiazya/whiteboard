import { Check, Copy, Download, Pencil } from 'lucide-react'
import { useRef } from 'react'
import { createPortal } from 'react-dom'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import type { SceneExportFormat } from '@/hooks/useDocumentSync'

interface DocumentActionsMenuProps {
  canvasUrl: string
  copyStatus: 'idle' | 'copied' | 'error'
  onCopyCanvasUrl: () => void
  onResetCopyStatus: () => void
  onStartRename: () => void
  onExport: ((format: SceneExportFormat) => void) | undefined
}

// One cohesive boundary for rename trigger, copy-URL, and export triggers —
// the Radix DropdownMenu portal and the onSelect preventDefault interplay
// (keeping the menu open so the copy confirmation is visible) are specific
// to this menu and do not belong split across separate files.
export function DocumentActionsMenu({
  canvasUrl,
  copyStatus,
  onCopyCanvasUrl,
  onResetCopyStatus,
  onStartRename,
  onExport,
}: DocumentActionsMenuProps) {
  // Anchor for the portaled copy-error fallback box below — it can no longer
  // rely on CSS `position: absolute` relative to this wrapper once it's
  // portaled to document.body, so its on-screen position is computed from
  // this element's own rect instead.
  const documentActionsRef = useRef<HTMLDivElement | null>(null)

  return (
    <div ref={documentActionsRef} className="relative">
      <DropdownMenu
        onOpenChange={(open) => {
          // Every fresh open starts from a clean confirmation state rather
          // than showing a stale "Copied!"/error from a previous visit.
          if (open) onResetCopyStatus()
        }}
      >
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="Canvas actions"
          >
            <Pencil className="size-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onSelect={onStartRename} className="gap-2">
            <Pencil className="size-3.5" />
            Rename canvas
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={(e) => {
              // Keep the menu open so the "Copied!"/error confirmation is
              // actually visible — Radix closes the menu on select by
              // default, which is exactly the silent-feedback bug.
              e.preventDefault()
              onCopyCanvasUrl()
            }}
            className="gap-2"
          >
            {copyStatus === 'copied' ? (
              <Check className="size-3.5 text-emerald-600" />
            ) : (
              <Copy className="size-3.5" />
            )}
            {copyStatus === 'copied' ? 'Copied!' : 'Copy canvas URL'}
          </DropdownMenuItem>
          {onExport && (
            <>
              <DropdownMenuItem onSelect={() => onExport('png')} className="gap-2">
                <Download className="size-3.5" />
                Export as PNG
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onExport('svg')} className="gap-2">
                <Download className="size-3.5" />
                Export as SVG
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {/* Both the live-region announcement and the error fallback below
          are portaled straight to document.body rather than rendered as
          siblings in this subtree, for two independent reasons:
          1. WAI-ARIA menu pattern: an element with role="menu" may only
             own menuitem/menuitemcheckbox/menuitemradio/group
             descendants, so neither can live inside the Radix menu
             content (axe/AccessLint: aria-required-children).
          2. copyDocumentUrl's onSelect handler above deliberately keeps
             this menu open on both success and failure so the
             confirmation is visible, and Radix's DismissableLayer inerts
             (aria-hides) the rest of the page for as long as the menu
             stays open. Rendering these two as ordinary siblings here —
             i.e. nested under this page's own <header>/<main> — meant
             their on-again-off-again presence changed *which* ancestor
             chain that inerting walk kept visible on every open/close of
             this menu, which went on to corrupt the hide/unhide
             bookkeeping for unrelated siblings elsewhere on the page
             (observed as BrowserLocalDocumentPage's destructive-action
             toolbar staying permanently aria-hidden after this menu had
             already closed). Portaling both directly to body gives each
             an ancestor chain of just `document.body`, so they can never
             again be nested inside — or, by omission, un-inert — any of
             this page's own DOM. */}
      {typeof document !== 'undefined' &&
        createPortal(
          <div aria-live="polite" role="status" aria-label="Copy status" className="sr-only">
            {copyStatus === 'copied' && 'Canvas URL copied to clipboard.'}
            {copyStatus === 'error' && "Couldn't copy the canvas URL automatically."}
          </div>,
          document.body,
        )}
      {typeof document !== 'undefined' &&
        copyStatus === 'error' &&
        createPortal(
          <div
            role="alert"
            style={(() => {
              const rect = documentActionsRef.current?.getBoundingClientRect()
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
              value={canvasUrl}
              onClick={(e) => {
                e.stopPropagation()
                e.currentTarget.select()
              }}
              onFocus={(e) => e.currentTarget.select()}
              aria-label="Canvas URL"
              className="mt-1 h-7 font-mono text-[11px]"
            />
          </div>,
          document.body,
        )}
    </div>
  )
}
