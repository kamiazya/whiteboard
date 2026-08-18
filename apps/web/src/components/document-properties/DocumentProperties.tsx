import type { StoredCoreFacets } from '@kamiazya/whiteboard-model'
import { Info, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { useId, useState } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip.js'

export interface DocumentPropertiesProps {
  /**
   * Renders as a segment of the merged header row instead of a standalone
   * chrome strip: no own border/background, and the Type/Tags disclosure
   * overlays below the header rather than growing the row (which would
   * push the canvas down mid-edit).
   */
  inline?: boolean
  /**
   * The document's NAME, which is a workspace concern rather than stored
   * content (ADR-0009 decision 2) — so it arrives as its own prop and leaves
   * through `onTitleChange`, not as a facet. The empty string is an unnamed
   * document; the box shows its placeholder.
   */
  readonly title: string
  /**
   * Absent when this backend cannot rename — the title then renders
   * read-only rather than accepting keystrokes it would discard.
   */
  readonly onTitleChange?: (next: string) => void
  /**
   * The document's OKF frontmatter, or absent when the document has none to
   * hold: a facet belongs to OKF and a JSON Canvas document has nowhere to
   * put one (ADR-0009 decision 3), so a spatial canvas omits both this and
   * `onFacetsChange` and gets no disclosure. Absent rather than a
   * `showFacets={false}` flag beside a value, because the flag hid the
   * disclosure while the document went on storing what it would have shown.
   */
  readonly facets?: StoredCoreFacets
  readonly onFacetsChange?: (next: StoredCoreFacets) => void
  /** Offered as datalist completions for `type`; the field stays free text. */
  readonly typeSuggestions?: readonly string[]
  /**
   * Save-state indicator, rendered LEFT of the title — the canvas's "am I
   * safe" signal reads before its name, like a title-bar dirty dot.
   */
  readonly status?: ReactNode
  /**
   * Canvas display settings control, rendered beside the properties toggle.
   * Spatial documents pass the settings popover; markdown documents omit it —
   * edge routing has no meaning for a document with no spatial scene.
   */
  readonly settings?: ReactNode
  /**
   * Right-edge cluster: canvas STATE and whole-document operations (save
   * chip, duplicate, delete). Supplied by the page — this component owns
   * the canvas row's layout, not the operations themselves.
   */
  readonly actions?: ReactNode
}

/**
 * Types a document rather than describing its storage: `markdown` is what a
 * fresh note gets, but the field is deliberately open — an OKF `type` is
 * what a reader keys a View off, and constraining it to a closed enum would
 * decide other people's vocabulary for them.
 */
const DEFAULT_TYPE_SUGGESTIONS = ['markdown', 'note', 'issue', 'spec', 'meeting'] as const

/**
 * The canvas row: the document's name, plus — for a document that HAS OKF
 * frontmatter — an editor for its core facets behind a disclosure.
 */
export function DocumentProperties({
  inline = false,
  title,
  onTitleChange,
  facets,
  onFacetsChange,
  typeSuggestions = DEFAULT_TYPE_SUGGESTIONS,
  status,
  settings,
  actions,
}: DocumentPropertiesProps) {
  const [open, setOpen] = useState(false)
  // Null means "not being edited" — the box then shows the canonical name.
  // While it is a string the box shows that instead, because the name comes
  // back NORMALISED (trimmed, and blank replaced by the unnamed sentinel) and
  // rendering the normalised form on the keystroke that typed a space erases
  // it: the next character lands flush against the previous word, and
  // "Release plan" typed one key at a time arrives as "Releaseplan".
  const [draftTitle, setDraftTitle] = useState<string | null>(null)
  const suggestionsId = useId()

  return (
    <div
      className={
        inline
          ? 'flex min-w-0 flex-1 items-center gap-2'
          : 'border-border bg-background flex flex-col gap-2 border-b px-3 py-2'
      }
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {status}
        <label className="sr-only" htmlFor={`${suggestionsId}-title`}>
          Title
        </label>
        <input
          id={`${suggestionsId}-title`}
          value={draftTitle ?? title}
          onChange={(event) => {
            if (onTitleChange === undefined) return
            setDraftTitle(event.target.value)
            onTitleChange(event.target.value)
          }}
          readOnly={onTitleChange === undefined}
          // Dropping the draft is the whole tidy-up: the box falls back to the
          // canonical name, which is already trimmed.
          onBlur={() => setDraftTitle(null)}
          placeholder="Untitled"
          className={`text-foreground placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent font-medium outline-none ${
            inline ? 'text-sm' : 'text-base'
          }`}
        />
        {facets !== undefined && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => setOpen((current) => !current)}
                aria-label="Properties"
                aria-expanded={open}
                aria-controls={`${suggestionsId}-disclosure`}
                className="text-muted-foreground hover:text-foreground shrink-0 rounded p-1.5"
              >
                <Info aria-hidden="true" className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Properties</TooltipContent>
          </Tooltip>
        )}
        {settings}
        {actions !== undefined && (
          <div className="ml-auto flex shrink-0 items-center gap-1.5">{actions}</div>
        )}
      </div>

      {facets !== undefined && open && (
        <FacetDisclosure
          id={`${suggestionsId}-disclosure`}
          suggestionsId={suggestionsId}
          inline={inline}
          facets={facets}
          onChange={onFacetsChange}
          typeSuggestions={typeSuggestions}
        />
      )}
    </div>
  )
}

/**
 * The Type/Tags editor. Its own component so the handlers below close over a
 * `facets` that is present by construction rather than re-proving it.
 *
 * Every handler emits a WHOLE `StoredCoreFacets`, never a patch, because
 * `writeCoreFacets` replaces the stored bucket outright and deletes any field
 * the caller omitted. `facetsRaw` — root-level frontmatter keys this app does
 * not model — therefore has to survive every edit untouched, or one tag edit
 * silently drops data the document arrived with.
 *
 * `view` is deliberately absent: its documented job is picking between Views
 * when several EXTENSION facets apply to one document, and extension facets
 * are not editable here yet, so the control would have nothing to choose
 * between.
 */
function FacetDisclosure({
  id,
  suggestionsId,
  inline,
  facets,
  onChange,
  typeSuggestions,
}: {
  readonly id: string
  readonly suggestionsId: string
  readonly inline: boolean
  readonly facets: StoredCoreFacets
  readonly onChange?: (next: StoredCoreFacets) => void
  readonly typeSuggestions: readonly string[]
}) {
  const [draftTag, setDraftTag] = useState('')
  const tags = facets.tags ?? []

  const withTags = (next: readonly string[]): StoredCoreFacets => {
    const { tags: _dropped, ...rest } = facets
    return next.length === 0 ? rest : { ...rest, tags: [...next] }
  }

  const commitDraftTag = () => {
    const tag = draftTag.trim()
    // Blank and duplicate both mean "nothing to add" — emitting anyway would
    // write an identical document and, for a duplicate, a misleading one.
    if (tag === '' || tags.includes(tag)) return
    onChange?.(withTags([...tags, tag]))
    setDraftTag('')
  }

  return (
    <div
      id={id}
      className={
        inline
          ? 'border-border bg-background absolute left-0 right-0 top-full z-20 flex flex-col gap-2 border-b px-3 py-2 shadow-md'
          : 'flex flex-col gap-2 pb-1'
      }
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <label
          className="text-muted-foreground w-12 shrink-0 text-xs"
          htmlFor={`${suggestionsId}-type`}
        >
          Type
        </label>
        <input
          id={`${suggestionsId}-type`}
          list={suggestionsId}
          value={facets.type}
          // `type` is the one required field in `coreFacetsSchema`, so an
          // emptied box is not a value to store — it is a half-finished
          // edit. Held locally rather than propagated.
          onChange={(event) => {
            const type = event.target.value
            if (type.trim() !== '') onChange?.({ ...facets, type })
          }}
          className="text-foreground border-border min-w-0 flex-1 rounded border bg-transparent px-2 py-1 text-sm outline-none"
        />
        <datalist id={suggestionsId}>
          {typeSuggestions.map((suggestion) => (
            <option key={suggestion} value={suggestion} />
          ))}
        </datalist>
      </div>

      <div className="flex min-w-0 flex-1 items-center gap-2">
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
                onClick={() => onChange?.(withTags(tags.filter((entry) => entry !== tag)))}
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
  )
}
