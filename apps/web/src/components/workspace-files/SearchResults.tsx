/**
 * What a search found, from anywhere in the workspace.
 *
 * Every row carries its full path, which the folder view deliberately does
 * not: there, the path is the pane you are standing in and repeating it on
 * every card would be noise. Here it is the only thing that says where the
 * document actually is, and the reason someone searched.
 */

import type { ReactNode } from 'react'
import { cn } from '../../lib/utils.js'
import type { WorkspaceDocumentEntry } from './document-entry.js'

export interface SearchResultsProps {
  results: readonly WorkspaceDocumentEntry[]
  selectedPath?: string
  onSelect: (document: WorkspaceDocumentEntry) => void
  renderThumbnail?: (document: WorkspaceDocumentEntry) => ReactNode
  className?: string
}

export function SearchResults({
  results,
  selectedPath,
  onSelect,
  renderThumbnail,
  className,
}: SearchResultsProps) {
  if (results.length === 0) {
    return <p className={cn('text-muted-foreground text-sm', className)}>Nothing matches.</p>
  }

  return (
    <ul className={cn('space-y-1 p-0.5', className)}>
      {results.map((entry) => (
        <li key={entry.documentId}>
          <button
            type="button"
            aria-current={entry.path === selectedPath ? 'true' : undefined}
            onClick={() => onSelect(entry)}
            className="hover:bg-accent/40 aria-[current]:border-primary aria-[current]:ring-primary/40 flex w-full min-w-0 items-center gap-2 rounded-md border p-1.5 text-left aria-[current]:ring-1"
          >
            {/* 80x44, not smaller: measured on a real document, a faithful
                render is a smear below roughly this and only here do the
                heading and the blocks separate. Recognising the document is
                the whole job of a search result, so this is the one list that
                pays for the height. */}
            <span className="bg-muted/40 flex h-11 w-20 shrink-0 items-center justify-center overflow-hidden rounded">
              {renderThumbnail?.(entry) ?? (
                <span
                  data-kind={entry.kind ?? 'markdown'}
                  className="text-muted-foreground text-xs"
                >
                  {entry.kind ?? 'markdown'}
                </span>
              )}
            </span>
            <span className="flex min-w-0 flex-col">
              <span data-testid="result-title" className="truncate text-sm">
                {entry.name ?? entry.path.split('/').at(-1)}
              </span>
              <span className="text-muted-foreground truncate font-mono text-xs">{entry.path}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}
