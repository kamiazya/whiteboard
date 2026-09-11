import { BookmarkPlus, Download, EllipsisVertical } from 'lucide-react'
import type { ReactNode, RefObject } from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu.js'
import { HEADER_BUTTON_CLASS } from '../../components/ui/header-button.js'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../components/ui/tooltip.js'
import type { SceneExportFormat } from '../../hooks/useDocumentSync.js'

interface DocumentMenuProps {
  /**
   * Already-wrapped export handler (the page owns the download and its error
   * state through `useSceneExport`). Omitted hides the export entry rather
   * than wiring a control to a capability the page has not set up.
   */
  readonly onExport?: (format: SceneExportFormat) => void
  /**
   * Asks for a bookmark: the page opens its History column with the naming
   * field ready. Omitted hides the row — a keeper with no history has no
   * list of points to name one in.
   */
  readonly onBookmark?: () => void
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
 * Its bands follow ADR-0006's order: the verbs, then whatever the page
 * contributes, ending in its destructive entry.
 *
 * The properties band that used to lead it is gone, and with it the whole
 * apparatus that opened one: `Display…` hung a popover off this trigger,
 * which had to be opened on the MENU'S CLOSE (a menu returns focus to its
 * trigger, and a popover open at that moment reads it as an interaction
 * outside itself and dismisses) and given the kebab back by hand on
 * dismissal. A canvas's display settings are now a panel in the page's one
 * inspector slot — `lib/inspector.ts` — where the sheet brings its own way
 * out and no two panels can be open at once.
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
export function DocumentMenu({ onExport, onBookmark, triggerRef, children }: DocumentMenuProps) {
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              ref={triggerRef}
              type="button"
              aria-label="More actions"
              className={HEADER_BUTTON_CLASS}
            >
              <EllipsisVertical aria-hidden="true" className="size-4" />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>More actions</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end">
        {onExport && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className="gap-2">
              <Download aria-hidden="true" className="size-3.5" />
              Export…
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem onSelect={() => onExport('png')}>Export as PNG</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onExport('svg')}>Export as SVG</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
        {onBookmark && (
          <DropdownMenuItem onSelect={onBookmark} className="gap-2">
            <BookmarkPlus aria-hidden="true" className="size-3.5" />
            Bookmark this point…
          </DropdownMenuItem>
        )}
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
