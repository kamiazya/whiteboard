import { FileSymlink, SquareArrowOutUpRight } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { isImeComposingKeydown } from '../../lib/ime-keydown.js'
import { cn } from '../../lib/utils.js'
import {
  externalLinkMarkup,
  type LinkTarget,
  linkMarkupFor,
  rankLinkTargets,
  urlFromQuery,
} from './link-target.js'

export interface LinkPickerDialogProps {
  readonly targets: readonly LinkTarget[]
  /** Seeded from the text the verb would have acted on — usually the caret's word. */
  readonly initialQuery: string
  /** The text an external link should carry; empty yields a bare autolink. */
  readonly linkText: string
  readonly onPick: (markup: string) => void
  readonly onCancel: () => void
}

/**
 * One surface for both kinds of link, because the author knows where they
 * want to go and not what we call it. What is typed decides: a name narrows
 * the workspace's documents, something URL-shaped puts "Link to <url>" at the
 * top of the same list. Nothing has to be classified before it is typed.
 *
 * The box is seeded with the word the verb would otherwise have wrapped, so
 * the pre-picker gesture still ends in one Enter rather than becoming a
 * search someone has to retype.
 */
export function LinkPickerDialog({
  targets,
  initialQuery,
  linkText,
  onPick,
  onCancel,
}: LinkPickerDialogProps) {
  const [query, setQuery] = useState(initialQuery)
  // Empty, not seeded: the default differs by destination — a document link
  // shows the document's own name, an external one shows the text that was
  // already there. Leaving this alone reproduces both, so the field only ever
  // means "instead of the default".
  const [display, setDisplay] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
  // Focus on open rather than via `autoFocus`: this dialog is opened by an
  // explicit verb, so typing is the next step and there is nowhere else for
  // focus to sit.
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const url = urlFromQuery(query)
  const matches = useMemo(() => rankLinkTargets(targets, query), [targets, query])
  const rows = useMemo(
    () => [
      ...(url === null ? [] : [{ kind: 'url' as const, url }]),
      ...matches.map((target) => ({ kind: 'document' as const, target })),
    ],
    [url, matches],
  )
  const activeIndex = Math.min(active, Math.max(0, rows.length - 1))

  const commit = (index: number) => {
    const row = rows[index]
    if (row === undefined) return
    const wanted = display.trim()
    onPick(
      row.kind === 'url'
        ? externalLinkMarkup(wanted === '' ? linkText : wanted, row.url)
        : linkMarkupFor(row.target, targets, wanted),
    )
  }

  return (
    <div
      data-editor-overlay
      data-testid="link-picker"
      role="dialog"
      aria-label="Link"
      className="bg-background rounded-md border p-2 shadow-lg"
      style={{
        position: 'absolute',
        zIndex: 30,
        left: '50%',
        top: '20%',
        transform: 'translateX(-50%)',
        width: 'min(22rem, calc(100% - 2rem))',
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          onCancel()
          return
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          const delta = event.key === 'ArrowDown' ? 1 : -1
          setActive((current) => {
            const next = Math.min(rows.length - 1, Math.max(0, current + delta))
            return next
          })
          return
        }
        if (event.key === 'Enter') {
          if (isImeComposingKeydown(event.nativeEvent)) return
          event.preventDefault()
          commit(activeIndex)
        }
      }}
    >
      <input
        id="link-picker-search"
        ref={inputRef}
        role="combobox"
        aria-expanded
        aria-controls="link-picker-list"
        aria-activedescendant={rows.length === 0 ? undefined : `link-picker-row-${activeIndex}`}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value)
          setActive(0)
        }}
        placeholder="Search documents, or paste a URL"
        aria-label="Search documents, or paste a URL"
        className="border-input focus-visible:ring-ring w-full rounded-md border px-2 py-1.5 text-sm focus-visible:ring-2 focus-visible:outline-none"
      />
      <label
        htmlFor="link-picker-text"
        className="text-muted-foreground mt-1.5 flex items-center gap-2 px-0.5 text-xs"
      >
        Text
        <input
          id="link-picker-text"
          value={display}
          onChange={(event) => setDisplay(event.target.value)}
          placeholder={
            rows[activeIndex]?.kind === 'url'
              ? linkText.trim() === ''
                ? 'The URL itself'
                : linkText
              : (rows[activeIndex]?.target.name ?? 'Same as the document name')
          }
          className="border-input focus-visible:ring-ring text-foreground min-w-0 flex-1 rounded-md border px-2 py-1 text-sm focus-visible:ring-2 focus-visible:outline-none"
        />
      </label>
      <div
        id="link-picker-list"
        role="listbox"
        aria-label="Link targets"
        className="mt-1 max-h-56 overflow-y-auto"
      >
        {rows.length === 0 && (
          <p className="text-muted-foreground px-2 py-3 text-xs">No document matches.</p>
        )}
        {rows.map((row, index) => {
          const key = row.kind === 'url' ? `url:${row.url}` : row.target.id
          const label = row.kind === 'url' ? row.url : row.target.name
          return (
            <button
              key={key}
              id={`link-picker-row-${index}`}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              onMouseEnter={() => setActive(index)}
              onClick={() => commit(index)}
              className={cn(
                'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm',
                index === activeIndex ? 'bg-accent text-foreground' : 'text-muted-foreground',
              )}
            >
              {row.kind === 'url' ? (
                <SquareArrowOutUpRight aria-hidden className="size-4 shrink-0" />
              ) : (
                <FileSymlink aria-hidden className="size-4 shrink-0" />
              )}
              <span className="truncate">{label}</span>
              {row.kind === 'url' && (
                <span className="text-muted-foreground ml-auto shrink-0 text-xs">External</span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
