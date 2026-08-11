import type { CanvasCoreMeta } from '@kamiazya/whiteboard-canvas-model'
import { X } from 'lucide-react'
import { useId, useState } from 'react'

export interface CanvasPropertiesProps {
  readonly meta: CanvasCoreMeta
  readonly onChange: (next: CanvasCoreMeta) => void
  /** Offered as datalist completions for `type`; the field stays free text. */
  readonly typeSuggestions?: readonly string[]
}

/**
 * Types a document rather than describing its storage: `markdown` is what a
 * fresh note gets, but the field is deliberately open — an OKF `type` is
 * what a reader keys a View off, and constraining it to a closed enum would
 * decide other people's vocabulary for them.
 */
const DEFAULT_TYPE_SUGGESTIONS = ['markdown', 'note', 'issue', 'spec', 'meeting'] as const

/**
 * Editor for the OKF CORE facets (`type` / `title` / `tags`).
 *
 * Every handler emits a WHOLE `CanvasCoreMeta`, never a patch, because
 * `writeCoreFacets` replaces the stored bucket outright and deletes any
 * field the caller omitted. `facetsRaw` — root-level frontmatter keys this
 * app does not model — therefore has to survive every edit here untouched,
 * or a title change silently drops data the document arrived with.
 *
 * `view` is deliberately absent: its documented job is picking between
 * Views when several EXTENSION facets apply to one canvas, and extension
 * facets are not editable here yet, so the control would have nothing to
 * choose between.
 */
export function CanvasProperties({
  meta,
  onChange,
  typeSuggestions = DEFAULT_TYPE_SUGGESTIONS,
}: CanvasPropertiesProps) {
  const [open, setOpen] = useState(false)
  const [draftTag, setDraftTag] = useState('')
  const suggestionsId = useId()
  const tags = meta.tags ?? []

  // An absent optional field and an empty one are different documents in
  // OKF: `title: ''` round-trips as an empty frontmatter value, while a
  // dropped key is simply untitled. Blank input means the latter.
  //
  // Only PRESENCE is decided by the trimmed form — the stored value stays
  // raw. The box is controlled from `meta.title`, so trimming here is not a
  // tidy-up, it is destructive: a trailing space is erased on the very
  // keystroke that types it, the input re-renders without it, and the next
  // character lands flush against the previous word ("Release plan" typed
  // one key at a time arrives as "Releaseplan"). `onBlur` does the tidying
  // instead, once the edit is finished.
  const withTitle = (raw: string): CanvasCoreMeta => {
    const { title: _dropped, ...rest } = meta
    return raw.trim() === '' ? rest : { ...rest, title: raw }
  }

  const withTags = (next: readonly string[]): CanvasCoreMeta => {
    const { tags: _dropped, ...rest } = meta
    return next.length === 0 ? rest : { ...rest, tags: [...next] }
  }

  const commitDraftTag = () => {
    const tag = draftTag.trim()
    // Blank and duplicate both mean "nothing to add" — emitting anyway would
    // write an identical document and, for a duplicate, a misleading one.
    if (tag === '' || tags.includes(tag)) return
    onChange(withTags([...tags, tag]))
    setDraftTag('')
  }

  return (
    <div className="border-border bg-background flex flex-col gap-2 border-b px-3 py-2">
      <div className="flex items-center gap-2">
        <label className="sr-only" htmlFor={`${suggestionsId}-title`}>
          Title
        </label>
        <input
          id={`${suggestionsId}-title`}
          value={meta.title ?? ''}
          onChange={(event) => onChange(withTitle(event.target.value))}
          onBlur={() => {
            const tidied = withTitle((meta.title ?? '').trim())
            if (tidied.title !== meta.title) onChange(tidied)
          }}
          placeholder="Untitled"
          className="text-foreground placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-base font-medium outline-none"
        />
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          aria-expanded={open}
          className="text-muted-foreground hover:text-foreground shrink-0 rounded px-2 py-1 text-xs"
        >
          Properties
        </button>
      </div>

      {open && (
        <div className="flex flex-col gap-2 pb-1">
          <div className="flex items-center gap-2">
            <label
              className="text-muted-foreground w-12 shrink-0 text-xs"
              htmlFor={`${suggestionsId}-type`}
            >
              Type
            </label>
            <input
              id={`${suggestionsId}-type`}
              list={suggestionsId}
              value={meta.type}
              // `type` is the one required field in `coreFacetsSchema`, so an
              // emptied box is not a value to store — it is a half-finished
              // edit. Held locally rather than propagated.
              onChange={(event) => {
                const type = event.target.value
                if (type.trim() !== '') onChange({ ...meta, type })
              }}
              className="text-foreground border-border min-w-0 flex-1 rounded border bg-transparent px-2 py-1 text-sm outline-none"
            />
            <datalist id={suggestionsId}>
              {typeSuggestions.map((suggestion) => (
                <option key={suggestion} value={suggestion} />
              ))}
            </datalist>
          </div>

          <div className="flex items-center gap-2">
            <label
              className="text-muted-foreground w-12 shrink-0 text-xs"
              htmlFor={`${suggestionsId}-tag`}
            >
              Tags
            </label>
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
              {tags.map((tag) => (
                <span
                  key={tag}
                  className="bg-muted text-muted-foreground inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs"
                >
                  {tag}
                  <button
                    type="button"
                    aria-label={`Remove tag ${tag}`}
                    onClick={() => onChange(withTags(tags.filter((entry) => entry !== tag)))}
                    className="hover:text-foreground"
                  >
                    <X aria-hidden className="size-3" />
                  </button>
                </span>
              ))}
              <input
                id={`${suggestionsId}-tag`}
                value={draftTag}
                onChange={(event) => setDraftTag(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ',') return
                  // Enter would submit an enclosing form and `,` would land in
                  // the box; both mean "finish this tag" here.
                  event.preventDefault()
                  commitDraftTag()
                }}
                onBlur={commitDraftTag}
                placeholder="Add tag"
                aria-label="Add tag"
                className="text-foreground placeholder:text-muted-foreground min-w-24 flex-1 bg-transparent text-xs outline-none"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
