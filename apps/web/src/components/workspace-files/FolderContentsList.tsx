import { CheckCircle2, ChevronRight, Circle, FileText, Folder, LayoutGrid, Pin } from 'lucide-react'
import { type ReactNode, useMemo } from 'react'
import type { WorkspaceDocumentEntry } from '../../lib/document-entry.js'
import { cn } from '../../lib/utils.js'
import { folderContents } from './folder-contents.js'
import { formatRelative } from './format-relative.js'
import { useLongPressMenu } from './use-long-press.js'

/**
 * What a click in the contents pane means. A folder and a document are
 * opened by different panes — one moves the browser, the other fills the
 * preview — so the list reports which it was rather than taking two handlers
 * a caller could wire to the same place.
 */
export type FolderContentsOpen =
  | { kind: 'folder'; path: string }
  | { kind: 'document'; document: WorkspaceDocumentEntry }

export interface FolderContentsListProps {
  documents: readonly WorkspaceDocumentEntry[]
  /** The folder being looked inside. `''` is the workspace root. */
  folder: string
  onOpen: (target: FolderContentsOpen) => void
  /**
   * The committed open — double-click, or Enter on a focused card. Space
   * keeps the native button click (select-and-preview), so a keyboard user
   * has both verbs where a mouse user has two gestures.
   */
  onActivateDocument?: (entry: WorkspaceDocumentEntry) => void
  /** Right-click or touch long-press on a document card — the object-action menu hook. */
  onDocumentContextMenu?: (entry: WorkspaceDocumentEntry, x: number, y: number) => void
  /** The document the preview is showing, so the two panes agree. */
  selectedPath?: string
  /**
   * The paths a live selection holds, or absent when there is no selection.
   *
   * Absent and empty are different: absent means the list is in its ordinary
   * mode and a card carries no `aria-pressed` at all, while empty would
   * announce every card as an unpressed toggle.
   */
  selection?: ReadonlySet<string>
  /**
   * The documentIds whose content has changed since this device last opened
   * them. Absent means the caller has no baseline to compare against, which
   * is not the same as "nothing changed" — a fresh device shows no dots
   * rather than dots on everything.
   */
  changed?: ReadonlySet<string>
  /**
   * A card's picture. This component neither fetches nor renders, so a
   * caller with no daemon to read from still gets a working list — with the
   * kind label the list already carries.
   */
  renderThumbnail?: (document: WorkspaceDocumentEntry) => ReactNode
  className?: string
}

/**
 * The kind, spoken in the tree rows' existing icon vocabulary rather than a
 * word — with the kind as the icon's accessible name, so what left the
 * subtitle text still answers to a reader.
 */
function KindBadge({ kind }: { kind: WorkspaceDocumentEntry['kind'] }) {
  const resolved = kind ?? 'markdown'
  const Icon = resolved === 'spatial' ? LayoutGrid : FileText
  return (
    <Icon
      data-testid="card-kind-badge"
      data-kind={resolved}
      role="img"
      aria-label={resolved}
      className="text-muted-foreground size-3.5 shrink-0"
    />
  )
}

export function FolderContentsList({
  documents,
  folder,
  onOpen,
  onActivateDocument,
  onDocumentContextMenu,
  selectedPath,
  selection,
  changed,
  renderThumbnail,
  className,
}: FolderContentsListProps) {
  const { folders, documents: here } = useMemo(
    () => folderContents(documents, folder),
    [documents, folder],
  )
  const longPress = useLongPressMenu(
    onDocumentContextMenu === undefined
      ? undefined
      : (path, x, y) => {
          const entry = here.find((row) => row.path === path)
          if (entry !== undefined) onDocumentContextMenu(entry, x, y)
        },
  )

  if (folders.length === 0 && here.length === 0) {
    return <p className={cn('text-muted-foreground text-sm', className)}>This folder is empty.</p>
  }

  return (
    <ul
      {...longPress}
      className={cn(
        'grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-2 p-0.5 md:grid-cols-[repeat(auto-fill,minmax(13rem,1fr))]',
        className,
      )}
    >
      {folders.map((child) => (
        <li key={child.path}>
          <button
            type="button"
            aria-label={`Open folder ${child.name}`}
            onClick={() => onOpen({ kind: 'folder', path: child.path })}
            className="hover:bg-accent flex w-full flex-col overflow-hidden rounded-md border text-left"
          >
            <span className="bg-muted/40 text-muted-foreground flex aspect-video w-full items-center justify-center">
              <Folder className="size-7" />
            </span>
            <span className="flex min-w-0 items-center gap-1 px-2 py-1.5">
              <span data-testid="card-title" className="truncate text-sm">
                {child.name}
              </span>
              {/* How much is inside, so a folder is not a blind alley to
                  click into — and the chevron says this card navigates. */}
              <span className="text-muted-foreground ml-auto shrink-0 text-xs tabular-nums">
                {child.count}
              </span>
              <ChevronRight className="text-muted-foreground size-3.5 shrink-0" />
            </span>
          </button>
        </li>
      ))}
      {here.map((entry) => (
        <li key={entry.documentId}>
          <button
            type="button"
            data-doc-path={entry.path}
            aria-current={entry.path === selectedPath ? 'true' : undefined}
            aria-pressed={selection === undefined ? undefined : selection.has(entry.path)}
            onClick={() => onOpen({ kind: 'document', document: entry })}
            onDoubleClick={
              onActivateDocument === undefined ? undefined : () => onActivateDocument(entry)
            }
            onKeyDown={
              onActivateDocument === undefined
                ? undefined
                : (event) => {
                    if (event.key === 'Enter') {
                      // Without this the keydown ALSO fires the native
                      // button click, selecting after the open.
                      event.preventDefault()
                      onActivateDocument(entry)
                    }
                  }
            }
            onContextMenu={
              onDocumentContextMenu === undefined
                ? undefined
                : (event) => {
                    event.preventDefault()
                    onDocumentContextMenu(entry, event.clientX, event.clientY)
                  }
            }
            // `group` + `aria-pressed:` so the SELECTED look is derived from
            // the attribute a screen reader reads, rather than written a
            // second time from `selection.has(...)`. toggle-state-surface
            // enforces that, and caught this card doing exactly the doubled
            // thing it forbids.
            className="group hover:bg-accent/40 aria-[current]:border-primary aria-[current]:ring-primary/40 aria-pressed:border-primary aria-pressed:bg-accent/30 flex w-full flex-col overflow-hidden rounded-md border text-left aria-[current]:ring-1"
          >
            <span className="bg-muted/40 relative flex aspect-video w-full items-center justify-center overflow-hidden">
              {renderThumbnail?.(entry) ?? (
                <span
                  data-kind={entry.kind ?? 'markdown'}
                  className="text-muted-foreground text-xs"
                >
                  {entry.kind ?? 'markdown'}
                </span>
              )}
              {/* Both drawn while a selection is live, and CSS picks between
                  them from the button's own `aria-pressed` — so the picture
                  cannot disagree with what is announced. Presence is gated on
                  the MODE, which is a different question from the state.
                  `aria-hidden` because the button already says it. */}
              {changed?.has(entry.documentId) && (
                /* Binary, and in the corner opposite the selection check so
                   the two never collide. `role="img"` with a name rather
                   than a bare colour: a dot nobody can see or hear is not a
                   signal, and this one contributes to the card's own
                   accessible name the way the kind badge already does. */
                <span
                  role="img"
                  aria-label="Changed since you last opened it"
                  data-testid="card-changed-dot"
                  className="bg-primary absolute top-1 right-1 size-2.5 rounded-full"
                />
              )}
              {selection !== undefined && (
                <>
                  <Circle
                    aria-hidden="true"
                    className="text-muted-foreground/70 absolute top-1 left-1 size-5 group-aria-pressed:hidden"
                  />
                  <CheckCircle2
                    aria-hidden="true"
                    className="fill-primary text-primary-foreground absolute top-1 left-1 hidden size-5 group-aria-pressed:block"
                  />
                </>
              )}
            </span>
            <span className="flex min-w-0 flex-col px-2 py-1.5">
              {/* The display name is the label everywhere else; the segment
                  is the fallback for a document nobody named, never a name
                  invented from the path. */}
              <span className="flex min-w-0 items-center gap-1">
                <KindBadge kind={entry.kind} />
                <span data-testid="card-title" className="truncate text-sm">
                  {entry.name ?? entry.path.split('/').at(-1)}
                </span>
                {entry.shadowed && (
                  <span
                    data-testid="card-shadowed-badge"
                    title="Another document owns this path. Rename this one to resolve the conflict."
                    className="shrink-0 rounded bg-amber-500/15 px-1 text-[10px] font-medium text-amber-600 dark:text-amber-400"
                  >
                    Path conflict
                  </span>
                )}
                {entry.pinOrder !== undefined && (
                  /* The pin used to exist only as a sort position — state a
                     reader could not see on the object it belongs to. */
                  <Pin
                    role="img"
                    aria-label="Pinned"
                    className="text-muted-foreground ml-auto size-3 shrink-0"
                  />
                )}
              </span>
              {entry.updatedAt !== undefined && (
                <span
                  data-testid="card-subtitle"
                  className="text-muted-foreground truncate text-xs"
                >
                  {formatRelative(entry.updatedAt)}
                </span>
              )}
              {(entry.tags?.length ?? 0) > 0 && (
                <span className="text-muted-foreground truncate text-[11px]">
                  {entry.tags?.map((tag) => `#${tag}`).join(' ')}
                </span>
              )}
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}
