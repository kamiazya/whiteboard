import { ChevronRight, Folder } from 'lucide-react'
import { type ReactNode, useMemo } from 'react'
import { cn } from '../../lib/utils.js'
import type { WorkspaceDocumentEntry } from './document-entry.js'
import { folderContents } from './folder-contents.js'
import { formatRelative } from './format-relative.js'

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
  /** Right-click on a document card — the object-action menu hook. */
  onDocumentContextMenu?: (entry: WorkspaceDocumentEntry, x: number, y: number) => void
  /** The document the preview is showing, so the two panes agree. */
  selectedPath?: string
  /**
   * A card's picture. This component neither fetches nor renders, so a
   * caller with no daemon to read from still gets a working list — with the
   * kind label the list already carries.
   */
  renderThumbnail?: (document: WorkspaceDocumentEntry) => ReactNode
  className?: string
}

/** `markdown · 2d ago`, dropping whichever half the daemon did not record. */
function cardSubtitle(entry: WorkspaceDocumentEntry): string {
  const age = entry.updatedAt === undefined ? '' : formatRelative(entry.updatedAt)
  return [entry.kind ?? '', age].filter((part) => part !== '').join(' · ')
}

export function FolderContentsList({
  documents,
  folder,
  onOpen,
  onDocumentContextMenu,
  selectedPath,
  renderThumbnail,
  className,
}: FolderContentsListProps) {
  const { folders, documents: here } = useMemo(
    () => folderContents(documents, folder),
    [documents, folder],
  )

  if (folders.length === 0 && here.length === 0) {
    return <p className={cn('text-muted-foreground text-sm', className)}>This folder is empty.</p>
  }

  return (
    <ul
      className={cn('grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-2 p-0.5', className)}
    >
      {folders.map((child) => (
        <li key={child.path}>
          <button
            type="button"
            aria-label={`Open folder ${child.name}`}
            onClick={() => onOpen({ kind: 'folder', path: child.path })}
            className="hover:bg-accent flex w-full flex-col overflow-hidden rounded-md border text-left"
          >
            <span className="bg-muted/40 text-muted-foreground flex h-16 w-full items-center justify-center">
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
            aria-current={entry.path === selectedPath ? 'true' : undefined}
            onClick={() => onOpen({ kind: 'document', document: entry })}
            onContextMenu={
              onDocumentContextMenu === undefined
                ? undefined
                : (event) => {
                    event.preventDefault()
                    onDocumentContextMenu(entry, event.clientX, event.clientY)
                  }
            }
            className="hover:bg-accent/40 aria-[current]:border-primary aria-[current]:ring-primary/40 flex w-full flex-col overflow-hidden rounded-md border text-left aria-[current]:ring-1"
          >
            <span className="bg-muted/40 flex h-16 w-full items-center justify-center overflow-hidden">
              {renderThumbnail?.(entry) ?? (
                <span
                  data-kind={entry.kind ?? 'markdown'}
                  className="text-muted-foreground text-xs"
                >
                  {entry.kind ?? 'markdown'}
                </span>
              )}
            </span>
            <span className="flex min-w-0 flex-col px-2 py-1.5">
              {/* The display name is the label everywhere else; the segment
                  is the fallback for a document nobody named, never a name
                  invented from the path. */}
              <span data-testid="card-title" className="truncate text-sm">
                {entry.name ?? entry.path.split('/').at(-1)}
              </span>
              <span data-testid="card-subtitle" className="text-muted-foreground truncate text-xs">
                {cardSubtitle(entry)}
              </span>
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
