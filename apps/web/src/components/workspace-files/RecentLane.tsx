import { FileText, LayoutGrid } from 'lucide-react'
import type { ReactNode } from 'react'
import type { WorkspaceDocumentEntry } from '../../lib/document-entry.js'
import { documentAccessibleName, documentLabel } from '../../lib/document-label.js'
import { useCompactSurface } from './use-compact-surface.js'

export interface RecentLaneProps {
  /** The listing as loaded. Recorded ids are resolved against it. */
  documents: readonly WorkspaceDocumentEntry[]
  /** Most recent first, from `recent-documents.ts`. */
  recentIds: readonly string[]
  /** One click: the host decides whether that selects or, on touch, opens. */
  onSelect: (entry: WorkspaceDocumentEntry) => void
  /** Double-click or Enter: the committed open. */
  onOpen: (entry: WorkspaceDocumentEntry) => void
  /** The document the preview is showing, so the lane agrees with the grid. */
  selectedPath?: string | undefined
  renderThumbnail?: (entry: WorkspaceDocumentEntry) => ReactNode
  /**
   * Columns in the grid below at its current width, when there is one. A lane
   * over documents that all fit in the grid's first row would show every card
   * twice, so it stays out of the way until the grid has something to scroll.
   */
  gridColumns?: number | undefined
}

function RecentTile({
  entry,
  selectedPath,
  onSelect,
  onOpen,
  renderThumbnail,
}: Pick<RecentLaneProps, 'onSelect' | 'onOpen' | 'renderThumbnail' | 'selectedPath'> & {
  entry: WorkspaceDocumentEntry
}) {
  const KindIcon = entry.kind === 'spatial' ? LayoutGrid : FileText
  return (
    <button
      type="button"
      aria-label={documentAccessibleName(entry, 'leaf')}
      aria-current={entry.path === selectedPath ? 'true' : undefined}
      onClick={() => onSelect(entry)}
      onDoubleClick={() => onOpen(entry)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          // Without this the keydown ALSO fires the native button click,
          // selecting after the open.
          event.preventDefault()
          onOpen(entry)
        }
      }}
      className="hover:bg-accent/40 aria-[current]:border-primary aria-[current]:ring-primary/40 flex w-28 shrink-0 flex-col overflow-hidden rounded-md border text-left aria-[current]:ring-1 md:w-32"
    >
      <span className="bg-muted/40 flex aspect-video w-full items-center justify-center overflow-hidden">
        {renderThumbnail?.(entry) ?? (
          <KindIcon
            role="img"
            aria-label={entry.kind ?? 'markdown'}
            className="text-muted-foreground size-4"
          />
        )}
      </span>
      {/* The display name, with the path's last segment as the label
                for a document nobody named — never a name invented from the
                path, which is the same rule the cards below follow. */}
      <span className="truncate px-2 py-1 text-xs">{documentLabel(entry, 'leaf')}</span>
    </button>
  )
}

/**
 * The documents this device opened most recently, as a strip above the grid.
 *
 * An ADDITION beside the grid rather than a reordering of it: the grid is
 * sorted by path, and where a card sits is what a person remembers about it.
 * Putting the newest first would move every card every time anything was
 * opened, which is the spatial memory the sort exists to give (NN/g).
 *
 * Resolved against the listing already in hand, so a deleted or renamed
 * document falls out on its own — the lane needs no reconciliation pass, and
 * a stale id costs nothing but its own absence.
 */
export function RecentLane({
  documents,
  recentIds,
  onSelect,
  onOpen,
  selectedPath,
  renderThumbnail,
  gridColumns,
}: RecentLaneProps) {
  const compact = useCompactSurface()
  const entries = recentIds
    .map((id) => documents.find((each) => each.documentId === id))
    .filter((each): each is WorkspaceDocumentEntry => each !== undefined)

  // Nothing recorded, or nothing recorded that still exists: the lane is
  // absent rather than empty. An empty strip is a row of chrome explaining
  // that there is nothing to show, which is the wordiness this redesign is
  // removing everywhere else.
  if (compact || entries.length === 0) return null
  if (gridColumns !== undefined && documents.length <= gridColumns) return null

  return (
    <section aria-label="Recently opened" data-testid="recent-lane" className="px-2 pb-2">
      {/* One word, and it earns its place: without it the strip reads as two
          unexplained tiles above the grid — pinned, maybe, or a selection.
          Every surveyed product labels this lane (Finder and iOS Files
          "Recents", Figma "Recently viewed"); what this redesign is cutting is
          instructional prose, not the noun that says what a thing is. */}
      <h2 className="text-muted-foreground pb-1 text-[11px] font-medium">Recent</h2>
      {/* Its own scroller: a phone fits two tiles, and the page body must
          never scroll sideways to reach the third. */}
      <div className="flex gap-2 overflow-x-auto">
        {entries.map((entry) => (
          <RecentTile
            key={entry.documentId}
            entry={entry}
            selectedPath={selectedPath}
            onSelect={onSelect}
            onOpen={onOpen}
            renderThumbnail={renderThumbnail}
          />
        ))}
      </div>
    </section>
  )
}
