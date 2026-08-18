import { ChevronRight, FileText, Folder, LayoutGrid } from 'lucide-react'
import { type ReactNode, useMemo } from 'react'
import { cn } from '../../lib/utils.js'
import { folderContents } from './folder-contents.js'
import type { WorkspaceFileTreeDocument } from './WorkspaceFileTree.js'

/**
 * What a click in the middle pane means. A folder and a document are opened
 * by different panes — one moves the browser, the other fills the preview —
 * so the list reports which it was rather than taking two handlers that a
 * caller could wire to the same place.
 */
export type FolderContentsOpen =
  | { kind: 'folder'; path: string }
  | { kind: 'document'; document: WorkspaceFileTreeDocument }

export interface FolderContentsListProps {
  documents: readonly WorkspaceFileTreeDocument[]
  /** The folder being looked inside. `''` is the workspace root. */
  folder: string
  onOpen: (target: FolderContentsOpen) => void
  /** The document the preview is showing, so the two panes agree. */
  selectedPath?: string
  /** A row's miniature — the same capability slot the tree takes. */
  renderIcon?: (document: WorkspaceFileTreeDocument) => ReactNode
  className?: string
}

export function FolderContentsList({
  documents,
  folder,
  onOpen,
  selectedPath,
  renderIcon,
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
    <ul className={cn('space-y-0.5', className)}>
      {folders.map((child) => (
        <li key={child.path}>
          <button
            type="button"
            aria-label={`Open folder ${child.name}`}
            onClick={() => onOpen({ kind: 'folder', path: child.path })}
            className="hover:bg-accent hover:text-accent-foreground flex w-full min-w-0 items-center gap-2 rounded px-2 py-1 text-left text-sm"
          >
            <Folder className="text-muted-foreground size-4 shrink-0" />
            <span className="truncate">{child.name}</span>
            {/* How much is inside, so a folder is not a blind alley to click
                into — and the chevron says this row navigates. */}
            <span className="text-muted-foreground ml-auto shrink-0 text-xs tabular-nums">
              {child.count}
            </span>
            <ChevronRight className="text-muted-foreground size-3.5 shrink-0" />
          </button>
        </li>
      ))}
      {here.map((entry) => (
        <li key={entry.documentId}>
          <button
            type="button"
            aria-current={entry.path === selectedPath ? 'true' : undefined}
            onClick={() => onOpen({ kind: 'document', document: entry })}
            className="hover:bg-accent hover:text-accent-foreground aria-[current]:bg-accent aria-[current]:text-accent-foreground flex w-full min-w-0 items-center gap-2 rounded px-2 py-1 text-left text-sm"
          >
            {renderIcon?.(entry) ??
              (entry.kind === 'spatial' ? (
                <LayoutGrid data-kind="spatial" className="text-muted-foreground size-4 shrink-0" />
              ) : (
                <FileText
                  data-kind={entry.kind ?? 'markdown'}
                  className="text-muted-foreground size-4 shrink-0"
                />
              ))}
            {/* The display name is the label everywhere else; the segment is
                the fallback for a document nobody named, never a name
                invented from the path. */}
            <span className="truncate">{entry.name ?? entry.path.split('/').at(-1)}</span>
          </button>
        </li>
      ))}
    </ul>
  )
}
