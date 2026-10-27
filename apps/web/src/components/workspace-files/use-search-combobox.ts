/**
 * The search box as a combobox over its results (WAI-ARIA APG, "editable
 * combobox with list autocomplete"): focus stays in the box while the arrow
 * keys move a highlight through the results, and Enter opens the highlighted
 * one — or the first, so typing a name and pressing Enter is enough.
 *
 * The box and the results are drawn by different components, so the results
 * PUBLISH what they show and how to open one, from an effect, and the box
 * reads that when a key arrives. The highlight is a document id rather than
 * an index: a search that re-ranks under it keeps the same document
 * highlighted, and one that drops it shows no highlight instead of moving it
 * onto a document nobody chose.
 */

import { type KeyboardEvent, useId, useLayoutEffect, useRef, useState } from 'react'
import type { WorkspaceDocumentEntry } from '../../lib/document-entry.js'

interface Published {
  readonly rows: readonly WorkspaceDocumentEntry[]
  readonly open: ((entry: WorkspaceDocumentEntry) => void) | undefined
}

interface BoxProps {
  readonly role: 'combobox'
  readonly 'aria-autocomplete': 'list'
  readonly 'aria-expanded': boolean
  readonly 'aria-controls'?: string
  readonly 'aria-activedescendant'?: string
  readonly onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void
}

export interface SearchCombobox {
  /** Spread onto the search box. */
  readonly boxProps: BoxProps
  readonly listboxId: string
  readonly activeDocumentId: string | null
  /** Where the results put what they show; written by `usePublishSearchResults`. */
  readonly published: { current: Published }
  readonly setShownIds: (ids: readonly string[]) => void
}

/** The DOM id of a result's option, which the box's activedescendant names. */
export function searchOptionId(listboxId: string, documentId: string): string {
  return `${listboxId}-${documentId}`
}

export function useSearchCombobox(query: string): SearchCombobox {
  const listboxId = useId()
  const [active, setActive] = useState<string | null>(null)
  const [shownIds, setShownIds] = useState<readonly string[]>([])
  const published = useRef<Published>({ rows: [], open: undefined })
  // A new query is a new list: what was highlighted in the old one is not a
  // choice the reader has made in this one.
  const [highlightedFor, setHighlightedFor] = useState(query)
  if (highlightedFor !== query) {
    setHighlightedFor(query)
    setActive(null)
  }
  const activeDocumentId = active !== null && shownIds.includes(active) ? active : null
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const { rows, open } = published.current
    if (event.key === 'Enter') return openOnEnter(event, rows, activeDocumentId, open)
    const next = moveHighlight(event.key, rows, activeDocumentId)
    if (next === undefined) return
    event.preventDefault()
    setActive(next)
  }
  const expanded = shownIds.length > 0
  const boxProps: BoxProps = {
    role: 'combobox',
    'aria-autocomplete': 'list',
    'aria-expanded': expanded,
    ...(expanded ? { 'aria-controls': listboxId } : {}),
    ...(activeDocumentId === null
      ? {}
      : { 'aria-activedescendant': searchOptionId(listboxId, activeDocumentId) }),
    onKeyDown,
  }
  return { boxProps, listboxId, activeDocumentId, published, setShownIds }
}

/** Enter opens the highlighted result, or the first when none is. */
function openOnEnter(
  event: KeyboardEvent<HTMLInputElement>,
  rows: Published['rows'],
  active: string | null,
  open: Published['open'],
): void {
  const target = rows.find((row) => row.documentId === active) ?? rows[0]
  if (target === undefined || open === undefined) return
  event.preventDefault()
  open(target)
}

/**
 * Where a key moves the highlight: a document id, `null` for none, or
 * `undefined` when the key is not the highlight's — so the box keeps its
 * own behaviour for it (Escape with nothing highlighted clears the query).
 */
function moveHighlight(
  key: string,
  rows: Published['rows'],
  active: string | null,
): string | null | undefined {
  const at = rows.findIndex((row) => row.documentId === active)
  if (key === 'ArrowDown' && rows.length > 0) {
    return rows[Math.min(at + 1, rows.length - 1)]?.documentId ?? null
  }
  if (key === 'ArrowUp' && at !== -1) return at === 0 ? null : (rows[at - 1]?.documentId ?? null)
  if (key === 'Escape' && active !== null) return null
  return undefined
}

/** The results' half: tells the box what is listed and how to open one. */
export function usePublishSearchResults(
  combobox: SearchCombobox,
  rows: readonly { readonly document: WorkspaceDocumentEntry }[],
  open: Published['open'],
): void {
  const { published, setShownIds } = combobox
  useLayoutEffect(() => {
    published.current = { rows: rows.map((row) => row.document), open }
  })
  // Keyed on the ids so a re-render with the same list sets nothing.
  const key = rows.map((row) => row.document.documentId).join('\n')
  useLayoutEffect(() => {
    setShownIds(key === '' ? [] : key.split('\n'))
    return () => setShownIds([])
  }, [key, setShownIds])
}
