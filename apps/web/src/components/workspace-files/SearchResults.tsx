/**
 * What a search found, from anywhere in the workspace.
 *
 * Every row carries its full path, which the folder view deliberately does
 * not: there, the path is the pane you are standing in and repeating it on
 * every card would be noise. Here it is the only thing that says where the
 * document actually is, and the reason someone searched. (The two surveyed
 * apps that flatten hierarchy WITHOUT restoring location per row — Finder and
 * Figma — both carry standing user complaints about exactly that.)
 *
 * The matched substring is marked in place, in the title and in the path:
 * a result list that will not say why a row is present makes the reader
 * re-run the search with their eyes.
 */

import { LayoutGrid, List } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../components/ui/tooltip.js'
import type { WorkspaceDocumentEntry } from '../../lib/document-entry.js'
import { cn } from '../../lib/utils.js'
import { useLongPressMenu } from './use-long-press.js'

/**
 * A row: the document, and the excerpts that say why it is here. Empty
 * contexts mean the match was in the name or the path — both already on
 * the row — so there is nothing more to show.
 */
export interface SearchResultRow {
  readonly document: WorkspaceDocumentEntry
  readonly contexts?: readonly string[]
  /**
   * The keyword rank behind this row, absent when keywords did not produce
   * it. Absent means the excerpt is the document's opening rather than a
   * match window, so there is no word in it the query is responsible for.
   */
  readonly lexicalRank?: number
  /**
   * Where this document sat in the SEMANTIC ranking, absent when no embedder
   * answered. Every embedded document appears in that ranking, so a rank on
   * its own says nothing about a row — it is meaningful here only beside an
   * absent `lexicalRank`, which together mean no keyword produced this row
   * and meaning is the only thing that did.
   */
  readonly semanticRank?: number
}

export interface SearchResultsProps {
  results: readonly SearchResultRow[]
  /** The query the results answer, so the match can be shown, not implied. */
  query: string
  /**
   * Whether document CONTENT was actually looked at. False while a content
   * search is unavailable, still in flight, or bypassed by a `#tag` filter —
   * cases where the answer came from names and paths alone, and an empty
   * state claiming otherwise would report a document as missing when nobody
   * looked inside it.
   */
  searchedContents?: boolean
  selectedPath?: string
  onSelect: (document: WorkspaceDocumentEntry) => void
  /**
   * The committed open — double-click, or Enter on a focused row. Space
   * keeps the native button click (select-and-preview).
   */
  onActivate?: (document: WorkspaceDocumentEntry) => void
  /** Right-click or touch long-press on a result row — the object-action menu hook. */
  onDocumentContextMenu?: (entry: WorkspaceDocumentEntry, x: number, y: number) => void
  renderThumbnail?: (document: WorkspaceDocumentEntry) => ReactNode
  className?: string
}

/**
 * The text with its first case-insensitive match marked. First only: one
 * highlight answers "why is this row here", and a title that matches four
 * times painted four times reads as damage rather than emphasis.
 */
function Highlighted({ text, query }: { text: string; query: string }) {
  const q = query.trim().toLowerCase()
  if (q === '') return <>{text}</>
  const at = text.toLowerCase().indexOf(q)
  if (at === -1) return <>{text}</>
  return (
    <>
      {text.slice(0, at)}
      <mark data-testid="search-match" className="rounded-sm bg-primary/20 text-inherit">
        {text.slice(at, at + q.length)}
      </mark>
      {text.slice(at + q.length)}
    </>
  )
}

function titleOf(entry: WorkspaceDocumentEntry): string {
  return entry.name ?? entry.path.split('/').at(-1) ?? entry.path
}

export function SearchResults({
  results,
  query,
  searchedContents = true,
  selectedPath,
  onSelect,
  onActivate,
  onDocumentContextMenu,
  renderThumbnail,
  className,
}: SearchResultsProps) {
  const longPress = useLongPressMenu(
    onDocumentContextMenu === undefined
      ? undefined
      : (path, x, y) => {
          const row = results.find(({ document: entry }) => entry.path === path)
          if (row !== undefined) onDocumentContextMenu(row.document, x, y)
        },
  )
  // List first: the row form carries the path inline beside the title, which
  // is the stronger answer to "where is this" — the grid trades that density
  // for a bigger picture, the way Finder's icon view does.
  const [layout, setLayout] = useState<'list' | 'grid'>('list')

  if (results.length === 0) {
    // Say what was searched, not just that nothing came back. Search here is
    // lexical: it finds the words a document actually contains, so a query
    // in one language structurally cannot reach a document written in
    // another (measured on this repo's own corpus: 21 of 22 such queries
    // returned nothing). "Nothing matches" alone would read as "no such
    // document" — naming the query and what was looked at lets the reader
    // tell a missing document from a query that could never match.
    return (
      <p className={cn('text-muted-foreground text-sm', className)}>
        Nothing matches “{query.trim()}” in the{' '}
        {searchedContents ? 'names, paths and contents' : 'names and paths'} of this workspace.
      </p>
    )
  }

  const thumbnail = (entry: WorkspaceDocumentEntry, sizeClass: string) => (
    <span
      className={cn(
        'bg-muted/40 flex shrink-0 items-center justify-center overflow-hidden rounded',
        sizeClass,
      )}
    >
      {renderThumbnail?.(entry) ?? (
        <span data-kind={entry.kind ?? 'markdown'} className="text-muted-foreground text-xs">
          {entry.kind ?? 'markdown'}
        </span>
      )}
    </span>
  )

  return (
    <div className={className}>
      <div className="mb-1 flex justify-end">
        <div className="flex items-center gap-0.5 rounded-md border p-0.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="List results"
                aria-pressed={layout === 'list'}
                onClick={() => setLayout('list')}
                className="text-muted-foreground aria-pressed:bg-accent aria-pressed:text-foreground rounded p-1"
              >
                <List className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent>List results</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="Grid results"
                aria-pressed={layout === 'grid'}
                onClick={() => setLayout('grid')}
                className="text-muted-foreground aria-pressed:bg-accent aria-pressed:text-foreground rounded p-1"
              >
                <LayoutGrid className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Grid results</TooltipContent>
          </Tooltip>
        </div>
      </div>
      {layout === 'list' ? (
        <ul {...longPress} data-testid="search-results-list" className="space-y-1 p-0.5">
          {results.map(({ document: entry, contexts, lexicalRank, semanticRank }) => (
            <li key={entry.documentId}>
              <button
                type="button"
                data-doc-path={entry.path}
                aria-current={entry.path === selectedPath ? 'true' : undefined}
                onClick={() => onSelect(entry)}
                onDoubleClick={onActivate === undefined ? undefined : () => onActivate(entry)}
                onKeyDown={
                  onActivate === undefined
                    ? undefined
                    : (event) => {
                        if (event.key === 'Enter') {
                          // Without this the keydown ALSO fires the native
                          // button click, selecting after the open.
                          event.preventDefault()
                          onActivate(entry)
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
                className="hover:bg-accent/40 aria-[current]:border-primary aria-[current]:ring-primary/40 flex w-full min-w-0 items-center gap-2 rounded-md border p-1.5 text-left aria-[current]:ring-1"
              >
                {/* 80x44, not smaller: measured on a real document, a faithful
                    render is a smear below roughly this and only here do the
                    heading and the blocks separate. Recognising the document is
                    the whole job of a search result, so this is the one list that
                    pays for the height. */}
                {thumbnail(entry, 'h-11 w-20')}
                <span className="flex min-w-0 flex-col">
                  <span data-testid="result-title" className="truncate text-sm">
                    <Highlighted text={titleOf(entry)} query={query} />
                  </span>
                  <span className="text-muted-foreground truncate font-mono text-xs">
                    <Highlighted text={entry.path} query={query} />
                  </span>
                  {(entry.tags?.length ?? 0) > 0 && (
                    /* A #tag query matches nothing visible in title or path,
                       so the row must show the tag that put it here. */
                    <span className="text-muted-foreground truncate text-[11px]">
                      {entry.tags?.map((tag) => `#${tag}`).join(' ')}
                    </span>
                  )}
                  {lexicalRank === undefined && semanticRank !== undefined && (
                    /* Why the row is here, when no word in it is. The excerpt
                       below is the document's opening rather than a match
                       window, so without this the row is indistinguishable
                       from one nothing matched at all. */
                    <span
                      data-testid="semantic-hit"
                      className="text-muted-foreground text-[10px] uppercase tracking-wide"
                    >
                      Matched by meaning
                    </span>
                  )}
                  {(contexts?.length ?? 0) > 0 && (
                    /* The match itself, when it was in the CONTENT: neither
                       the title nor the path shows it, so without this the
                       row cannot say why it is here. */
                    <span
                      data-testid="result-excerpt"
                      className="text-muted-foreground line-clamp-2 text-[11px] leading-snug"
                    >
                      {lexicalRank === undefined ? (
                        (contexts?.[0] ?? '')
                      ) : (
                        <Highlighted text={contexts?.[0] ?? ''} query={query} />
                      )}
                    </span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <ul
          {...longPress}
          data-testid="search-results-grid"
          className="grid grid-cols-2 gap-2 p-0.5 md:grid-cols-3"
        >
          {results.map(({ document: entry, contexts, lexicalRank, semanticRank }) => (
            <li key={entry.documentId}>
              <button
                type="button"
                data-doc-path={entry.path}
                aria-current={entry.path === selectedPath ? 'true' : undefined}
                onClick={() => onSelect(entry)}
                onDoubleClick={onActivate === undefined ? undefined : () => onActivate(entry)}
                onKeyDown={
                  onActivate === undefined
                    ? undefined
                    : (event) => {
                        if (event.key === 'Enter') {
                          // Without this the keydown ALSO fires the native
                          // button click, selecting after the open.
                          event.preventDefault()
                          onActivate(entry)
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
                className="hover:bg-accent/40 aria-[current]:border-primary aria-[current]:ring-primary/40 flex w-full min-w-0 flex-col gap-1.5 rounded-md border p-2 text-left aria-[current]:ring-1"
              >
                {thumbnail(entry, 'aspect-[16/9] w-full')}
                <span className="flex min-w-0 flex-col">
                  <span data-testid="result-title" className="truncate text-sm">
                    <Highlighted text={titleOf(entry)} query={query} />
                  </span>
                  {/* The path stays on the card. Dropping it here would
                      reintroduce the Finder/Figma gap the list avoids. */}
                  <span className="text-muted-foreground truncate font-mono text-xs">
                    <Highlighted text={entry.path} query={query} />
                  </span>
                  {(entry.tags?.length ?? 0) > 0 && (
                    /* A #tag query matches nothing visible in title or path,
                       so the row must show the tag that put it here. */
                    <span className="text-muted-foreground truncate text-[11px]">
                      {entry.tags?.map((tag) => `#${tag}`).join(' ')}
                    </span>
                  )}
                  {lexicalRank === undefined && semanticRank !== undefined && (
                    /* Why the row is here, when no word in it is. The excerpt
                       below is the document's opening rather than a match
                       window, so without this the row is indistinguishable
                       from one nothing matched at all. */
                    <span
                      data-testid="semantic-hit"
                      className="text-muted-foreground text-[10px] uppercase tracking-wide"
                    >
                      Matched by meaning
                    </span>
                  )}
                  {(contexts?.length ?? 0) > 0 && (
                    /* The match itself, when it was in the CONTENT: neither
                       the title nor the path shows it, so without this the
                       row cannot say why it is here. */
                    <span
                      data-testid="result-excerpt"
                      className="text-muted-foreground line-clamp-2 text-[11px] leading-snug"
                    >
                      {lexicalRank === undefined ? (
                        (contexts?.[0] ?? '')
                      ) : (
                        <Highlighted text={contexts?.[0] ?? ''} query={query} />
                      )}
                    </span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
