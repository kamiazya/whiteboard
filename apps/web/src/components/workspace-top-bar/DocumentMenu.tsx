import type { DocumentKind } from '@kamiazya/whiteboard-model'
import { BookmarkPlus, Download, EllipsisVertical, Printer } from 'lucide-react'
import { type ReactNode, type RefObject, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu.js'
import { HEADER_BUTTON_CLASS } from '../../components/ui/header-button.js'
import { SilentToast } from '../../components/ui/toast.js'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../components/ui/tooltip.js'
import type { SceneExportFormat } from '../../hooks/useDocumentSync.js'
import { usePictureExportPreferences } from '../../hooks/usePictureExportPreferences.js'
import type { EditorSelection, SelectionSource } from '../../lib/spatial/editor-handle.js'
import type { ExportScope } from '../../lib/spatial/selection-picture.js'
import { MARKDOWN_SAVED_NOTICE, NOTICE_CAVEAT_SEPARATOR } from './useSceneExport.js'

interface DocumentMenuProps {
  /**
   * Already-wrapped export handler (the page owns the download and its error
   * state through `useSceneExport`). Omitted hides the export entry rather
   * than wiring a control to a capability the page has not set up.
   */
  readonly onExport?: (format: SceneExportFormat, scope?: ExportScope) => void
  /**
   * What the canvas has selected. While a node is, the pictures can be of
   * the selection alone; omitted (a note, a past version) offers the whole
   * document only.
   */
  readonly selection?: SelectionSource
  /**
   * What the open document is, which decides the file it can be saved as
   * beside the pictures (a note's Markdown, a canvas's JSON Canvas). Omitted
   * offers the pictures alone.
   */
  readonly kind?: DocumentKind
  /**
   * Asks for a bookmark: the page opens its History column with the naming
   * field ready. Omitted hides the row — a keeper with no history has no
   * list of points to name one in.
   */
  readonly onBookmark?: () => void
  /**
   * Prints the document — a note prints its read view, over pages, without
   * the app around it. Omitted hides the row: only a note has a print view.
   */
  readonly onPrint?: () => void
  /**
   * What the row just did, for the polite status region it carries ("Exported
   * as PNG", "Copied as JSON Canvas"). The page owns the actions, so it owns
   * the words; the region lives here so the row has exactly one.
   */
  readonly notice?: string | null
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
 * There is one, not a pair a header apart — a pencil owning rename/copy/export
 * beside a kebab owning export/duplicate/delete would put export in both, and
 * because only the daemon page wired an export handler, the same pencil icon
 * would open a different menu depending on the backend. ADR-0006 puts
 * per-object actions on the object, and the open document is one object.
 *
 * Its bands follow ADR-0006's order: the verbs, then whatever the page
 * contributes, ending in its destructive entry.
 *
 * There is no properties band, and so none of the apparatus that opens one: a
 * `Display…` entry hanging a popover off this trigger would have to be opened
 * on the MENU'S CLOSE (a menu returns focus to its trigger, and a popover
 * open at that moment reads it as an interaction outside itself and
 * dismisses) and given the kebab back by hand on dismissal. A canvas's
 * display settings are a panel in the page's one inspector slot — `lib/inspector.ts` — where the sheet brings its own way
 * out and no two panels can be open at once.
 *
 * Rename is deliberately absent: naming happens in place on the title field
 * (ADR-0006 point 3), and changing a document's PATH as well as its name is
 * the document browser's Rename dialog, where the tree the move affects is
 * visible.
 *
 * So is "Copy link". Handing out a link is a promise about who can reach the
 * document, and the keeper decides that: one kept in this browser is
 * reachable from no other browser at all. A link built from the document's
 * PATH would also break on a rename, for every link already handed out.
 * Sharing returns when it is designed against the keeper
 * that has to honour it.
 */
export function DocumentMenu({
  onExport,
  selection,
  kind,
  onBookmark,
  onPrint,
  notice,
  triggerRef,
  children,
}: DocumentMenuProps) {
  return (
    <>
      {/* Mounted before it speaks and clipped rather than hidden, so a screen
          reader announces the change of text. */}
      <span role="status" aria-live="polite" className="sr-only">
        {notice ?? ''}
      </span>
      <MarkdownSavedToast notice={notice} />
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
          {onExport && <ExportSubmenu onExport={onExport} kind={kind} selection={selection} />}
          {onPrint && <PrintItem onPrint={onPrint} />}
          {onBookmark && (
            <DropdownMenuItem onSelect={onBookmark} className="gap-2">
              <BookmarkPlus aria-hidden="true" className="size-3.5" />
              Bookmark this point…
            </DropdownMenuItem>
          )}
          {children}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}

const NO_SELECTION: EditorSelection = { selectedId: null, selectedEdgeId: null, extraIds: [] }
const NO_SOURCE: SelectionSource = {
  getSelection: () => NO_SELECTION,
  subscribeSelection: () => () => {},
}

function selectedNodeIds(selection: EditorSelection): readonly string[] {
  return selection.selectedId === null ? [] : [selection.selectedId, ...selection.extraIds]
}

/**
 * The "Selection only" choice and the picture export it shapes. A choice made
 * for this open of the menu, not a remembered preference: what is selected
 * next time is a different selection.
 */
function useSelectionScope(
  selection: SelectionSource | undefined,
  kind: DocumentKind | undefined,
  onExport: (format: SceneExportFormat, scope?: ExportScope) => void,
) {
  const source = selection ?? NO_SOURCE
  const current = useSyncExternalStore(
    source.subscribeSelection,
    source.getSelection,
    source.getSelection,
  )
  const nodeIds = kind === 'spatial' ? selectedNodeIds(current) : []
  const [selectionOnly, setSelectionOnly] = useState(false)
  const picture = (format: SceneExportFormat) => () =>
    selectionOnly && nodeIds.length > 0 ? onExport(format, { nodeIds }) : onExport(format)
  return { nodeIds, selectionOnly, setSelectionOnly, picture }
}

function ExportSubmenu({
  onExport,
  kind,
  selection,
}: {
  readonly onExport: (format: SceneExportFormat, scope?: ExportScope) => void
  readonly kind: DocumentKind | undefined
  readonly selection: SelectionSource | undefined
}) {
  const { nodeIds, selectionOnly, setSelectionOnly, picture } = useSelectionScope(
    selection,
    kind,
    onExport,
  )
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger className="gap-2">
        <Download aria-hidden="true" className="size-3.5" />
        Export…
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <PictureEntries kind={kind} picture={picture} />
        {kind === 'markdown' && <MarkdownSaveItem onSave={() => onExport('md')} />}
        {kind === 'spatial' && (
          <DropdownMenuItem onSelect={() => onExport('canvas')}>
            Save as JSON Canvas (.canvas)
          </DropdownMenuItem>
        )}
        {kind !== 'markdown' && (
          <PictureOptionItems
            selectionCount={nodeIds.length}
            selectionOnly={selectionOnly}
            onSelectionOnlyChange={setSelectionOnly}
          />
        )}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

function PictureEntries({
  kind,
  picture,
}: {
  readonly kind: DocumentKind | undefined
  readonly picture: (format: SceneExportFormat) => () => void
}) {
  return (
    <>
      {/* A note is text: its export is the .md file. The pictures are of the
          canvas, and so are the options that shape them. */}
      {kind !== 'markdown' && (
        <>
          <DropdownMenuItem onSelect={picture('png')}>Export as PNG</DropdownMenuItem>
          <DropdownMenuItem onSelect={picture('svg')}>Export as SVG</DropdownMenuItem>
        </>
      )}
      {kind === 'spatial' && (
        <>
          <DropdownMenuItem onSelect={picture('png-comments')}>
            Export as PNG (with comments)
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={picture('svg-comments')}>
            Export as SVG (with comments)
          </DropdownMenuItem>
        </>
      )}
    </>
  )
}

function PictureOptionItems({
  selectionCount,
  selectionOnly,
  onSelectionOnlyChange,
}: {
  readonly selectionCount: number
  readonly selectionOnly: boolean
  readonly onSelectionOnlyChange: (on: boolean) => void
}) {
  const { options, setScale, setBackground } = usePictureExportPreferences()
  return (
    <>
      <DropdownMenuSeparator />
      {/* A selected frame brings the nodes inside it, as an embed of the
          frame's label does. The JSON Canvas save stays the whole document:
          it is the document, not a picture of it. */}
      {selectionCount > 0 && (
        <DropdownMenuCheckboxItem
          checked={selectionOnly}
          onCheckedChange={onSelectionOnlyChange}
          onSelect={(event) => event.preventDefault()}
        >
          Selection only ({selectionCount === 1 ? '1 item' : `${selectionCount} items`}, PNG/SVG)
        </DropdownMenuCheckboxItem>
      )}
      {/* A choice about the picture entries above, not an action: keeping the
          menu open lets both be set before the export that uses them. An SVG
          has no pixels, so the resolution is named as the PNG's. */}
      <DropdownMenuCheckboxItem
        checked={options.scale === 2}
        onCheckedChange={(on) => setScale(on ? 2 : 1)}
        onSelect={(event) => event.preventDefault()}
      >
        2× resolution (PNG)
      </DropdownMenuCheckboxItem>
      <DropdownMenuCheckboxItem
        checked={options.background}
        onCheckedChange={setBackground}
        onSelect={(event) => event.preventDefault()}
      >
        With background
      </DropdownMenuCheckboxItem>
    </>
  )
}

function PrintItem({ onPrint }: { readonly onPrint: () => void }) {
  return (
    <DropdownMenuItem onSelect={onPrint} className="gap-2">
      <Printer aria-hidden="true" className="size-3.5" />
      Print / Save as PDF…
    </DropdownMenuItem>
  )
}

function MarkdownSaveItem({ onSave }: { readonly onSave: () => void }) {
  return (
    <DropdownMenuItem
      onSelect={onSave}
      className="flex-col items-start gap-0.5"
      aria-describedby="markdown-export-scope"
    >
      Save as Markdown (.md)
      {/* Said where the choice is made: the file is the text, and a
          handout with its pictures is the print. Hidden from the
          item's NAME and read as its description instead. */}
      <span id="markdown-export-scope" aria-hidden="true" className="text-muted-foreground text-xs">
        Text only — pictures and embedded diagrams are not included. For a handout, use Print / Save
        as PDF.
      </span>
    </DropdownMenuItem>
  )
}

/**
 * A Markdown save is confirmed on screen as well as aloud: the file is the
 * text alone, and what it left out has to reach a sighted reader at the
 * moment it happened, not only under the menu entry they already closed.
 * Silent, because the status region above already speaks the same notice.
 * Portalled to the body so no transformed ancestor in the header can become
 * the containing block of its fixed position.
 */
function MarkdownSavedToast({ notice }: { readonly notice: string | null | undefined }) {
  if (notice == null || !notice.startsWith(MARKDOWN_SAVED_NOTICE)) return null
  const caveat = notice.slice(MARKDOWN_SAVED_NOTICE.length + NOTICE_CAVEAT_SEPARATOR.length)
  return createPortal(
    <SilentToast
      testId="markdown-saved-toast"
      message={
        <>
          <span className="font-medium">{MARKDOWN_SAVED_NOTICE}</span>
          {caveat !== '' && (
            <span className="text-muted-foreground block text-xs">
              {`${caveat.charAt(0).toUpperCase()}${caveat.slice(1)}.`}
            </span>
          )}
        </>
      }
    />,
    document.body,
  )
}
