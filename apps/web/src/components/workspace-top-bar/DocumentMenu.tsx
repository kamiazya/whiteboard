import { BookmarkPlus, Download, EllipsisVertical, SlidersHorizontal } from 'lucide-react'
import { type ReactNode, type RefObject, useState } from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu.js'
import { HEADER_BUTTON_CLASS } from '../../components/ui/header-button.js'
import { Popover, PopoverAnchor, PopoverContent } from '../../components/ui/popover.js'
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
   * The canvas display panel, shown in a popover hung off this menu's own
   * trigger. Omitted hides the row — a markdown document has no canvas to
   * configure.
   */
  readonly display?: ReactNode
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
 * Its bands follow ADR-0006's order: the properties band first (Display…),
 * then the verbs, then whatever the page contributes, ending in its
 * destructive entry.
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
export function DocumentMenu({
  onExport,
  display,
  onBookmark,
  triggerRef,
  children,
}: DocumentMenuProps) {
  // The display panel is a popover rather than a submenu because its widgets
  // are segmented controls a person adjusts several times in a row, and a
  // menu closes on the first select. Opened from a row that unmounts with
  // the menu, so it hangs off the trigger below instead.
  const [displayOpen, setDisplayOpen] = useState(false)
  return (
    <Popover open={displayOpen} onOpenChange={setDisplayOpen}>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverAnchor asChild>
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
            </PopoverAnchor>
          </TooltipTrigger>
          <TooltipContent>More actions</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end">
          {display !== undefined && (
            <>
              <DropdownMenuItem onSelect={() => setDisplayOpen(true)} className="gap-2">
                <SlidersHorizontal aria-hidden="true" className="size-3.5" />
                Display…
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
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
      {display !== undefined && (
        <PopoverContent data-testid="canvas-settings-menu" className="w-auto min-w-52 p-2">
          {display}
        </PopoverContent>
      )}
    </Popover>
  )
}
