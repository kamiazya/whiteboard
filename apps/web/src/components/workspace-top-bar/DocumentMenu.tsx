import { Download, EllipsisVertical } from 'lucide-react'
import type { ReactNode, RefObject } from 'react'
import { Button } from '../../components/ui/button.js'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu.js'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../components/ui/tooltip.js'
import type { SceneExportFormat } from '../../hooks/useDocumentSync.js'

interface DocumentMenuProps {
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
 *
 * So is "Copy link". Handing out a link is a promise about who can reach the
 * document, and the keeper decides that: one kept in this browser is
 * reachable from no other browser at all. The link this menu used to copy was
 * built from the document's PATH, so renaming it also broke every link
 * already handed out. Sharing returns when it is designed against the keeper
 * that has to honour it.
 */
export function DocumentMenu({ onExport, triggerRef, children }: DocumentMenuProps) {
  return (
    <DropdownMenu>
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
  )
}
