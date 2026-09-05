import type { StoredCoreFacets } from '@kamiazya/whiteboard-model'
import { Info, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { useId, useRef, useState } from 'react'
import { HEADER_TOGGLE_CLASS } from '../../components/ui/header-button.js'
import { isImeComposingKeydown } from '../../lib/ime-keydown.js'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip.js'

export interface DocumentPropertiesProps {
  /**
   * Renders as a segment of the merged header row instead of a standalone
   * chrome strip: no own border/background.
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
   * `onFacetsChange` and gets no Properties opener. Absent rather than a
   * `showFacets={false}` flag beside a value, because the flag hid the
   * opener while the document went on storing what it would have shown.
   *
   * The row only OPENS the editor: `DocumentFacetsEditor` lives in the
   * page's inspector slot beside the document, which the row does not own.
   */
  readonly facets?: StoredCoreFacets
  /** Whether the inspector slot is showing the facets editor. */
  readonly propertiesOpen?: boolean
  readonly onToggleProperties?: () => void
  /**
   * Save-state indicator, rendered LEFT of the title — the canvas's "am I
   * safe" signal reads before its name, like a title-bar dirty dot.
   */
  readonly status?: ReactNode
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
 * frontmatter — the opener for its core-facet editor.
 */
export function DocumentProperties({
  inline = false,
  title,
  onTitleChange,
  facets,
  propertiesOpen = false,
  onToggleProperties,
  status,
  actions,
}: DocumentPropertiesProps) {
  // Null means "not being edited" — the box then shows the canonical name.
  // While it is a string the box shows that instead, because the name comes
  // back NORMALISED (trimmed, and blank replaced by the unnamed sentinel) and
  // rendering the normalised form on the keystroke that typed a space erases
  // it: the next character lands flush against the previous word, and
  // "Release plan" typed one key at a time arrives as "Releaseplan".
  const [draftTitle, setDraftTitle] = useState<string | null>(null)
  // The name this field held when the current edit began. Every keystroke is
  // already committed (there is no Save button), so Escape has nothing to
  // discard — it has to put the previous name BACK. Without it, "type, change
  // your mind, Escape" silently keeps the half-typed name.
  const editBaselineRef = useRef(title)
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
          enterKeyHint="done"
          value={draftTitle ?? title}
          onChange={(event) => {
            if (onTitleChange === undefined) return
            setDraftTitle(event.target.value)
            onTitleChange(event.target.value)
          }}
          readOnly={onTitleChange === undefined}
          onFocus={() => {
            editBaselineRef.current = title
          }}
          // stopPropagation is belt-and-braces: the editor binds its shortcuts
          // on its own root and guards them with isTextEntryEvent, but a stray
          // Delete reaching a canvas selection from the title box is the kind
          // of defect nobody reports as a keyboard bug. Window-capture
          // bindings (Cmd+S) are unaffected by it.
          onKeyDown={(event) => {
            event.stopPropagation()
            // Enter finishes the edit. Every keystroke is already committed
            // (there is no Save button), so finishing means BLURRING: the
            // focus ring goes away and the save dot is the receipt. Never on
            // the Enter that confirms an IME conversion — that one means
            // "accept this word", and the field must stay open under it.
            if (event.key === 'Enter') {
              if (isImeComposingKeydown(event.nativeEvent)) return
              event.preventDefault()
              event.currentTarget.blur()
              return
            }
            if (event.key !== 'Escape' || onTitleChange === undefined) return
            event.preventDefault()
            setDraftTitle(null)
            // Compared against what the BOX holds, never against `title`: the
            // commit is async, so `title` can still be the old name here and a
            // comparison to it would decide "nothing changed" while a rename
            // to the typed value is already in flight.
            if ((draftTitle ?? title) !== editBaselineRef.current) {
              onTitleChange(editBaselineRef.current)
            }
            event.currentTarget.blur()
          }}
          onKeyUp={(event) => event.stopPropagation()}
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
                onClick={onToggleProperties}
                aria-label="Properties"
                aria-expanded={propertiesOpen}
                className={HEADER_TOGGLE_CLASS}
              >
                <Info aria-hidden="true" className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Properties</TooltipContent>
          </Tooltip>
        )}
        {actions !== undefined && (
          <div className="ml-auto flex shrink-0 items-center gap-1.5">{actions}</div>
        )}
      </div>
    </div>
  )
}

/**
 * The core-facet editor — OKF's `type`, `description`, `resource` and `tags`
 * — shown in the page's inspector slot when the row's Properties opener is
 * pressed. Its own component so the handlers below close over a `facets`
 * that is present by construction rather than re-proving it.
 *
 * The labels are the product's words, not the format's: OKF's `description`
 * is shown as "Summary" and `resource` as "Describes", because those read to
 * someone who has never heard of OKF. What is STORED is the spec's spelling;
 * only the label is translated.
 *
 * `resource` is NOT labelled "Source". OKF has a separate `sources` field for
 * provenance (§5.1) meaning something else entirely — the materials a concept
 * derives FROM, rather than the asset it describes — and the two would be
 * indistinguishable in a properties panel.
 *
 * Neither field carries an `aria-label`. One would override the visible label
 * as the accessible name, so a voice-control user saying what they can see
 * would match nothing (WCAG 2.5.3). The `<label htmlFor>` is the name.
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
export function DocumentFacetsEditor({
  facets,
  onChange,
  typeSuggestions = DEFAULT_TYPE_SUGGESTIONS,
}: {
  readonly facets: StoredCoreFacets
  readonly onChange?: (next: StoredCoreFacets) => void
  /** Offered as datalist completions for `type`; the field stays free text. */
  readonly typeSuggestions?: readonly string[]
}) {
  const suggestionsId = useId()
  const [draftTag, setDraftTag] = useState('')
  const tags = facets.tags ?? []

  const withTags = (next: readonly string[]): StoredCoreFacets => {
    const { tags: _dropped, ...rest } = facets
    return next.length === 0 ? rest : { ...rest, tags: [...next] }
  }

  /**
   * A blank summary is no summary, so it is emitted as an ABSENT key rather
   * than `description: ""` — an empty key would reach the exported OKF for a
   * reader to skip past, and OKF's own framing is that a missing optional
   * field carries meaning. Same shape as `withTags`'s empty-list rule.
   */
  const withOptional = (key: 'description' | 'resource', value: string): StoredCoreFacets => {
    const { [key]: _dropped, ...rest } = facets
    const trimmed = value.trim()
    return trimmed === '' ? rest : { ...rest, [key]: value }
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
    <div data-testid="document-facets-editor" className="flex flex-col gap-2 px-3 py-2">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <label
          className="text-muted-foreground w-16 shrink-0 text-xs"
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
          className="text-muted-foreground w-16 shrink-0 text-xs"
          htmlFor={`${suggestionsId}-description`}
        >
          Summary
        </label>
        <input
          id={`${suggestionsId}-description`}
          value={facets.description ?? ''}
          onChange={(event) => onChange?.(withOptional('description', event.target.value))}
          placeholder="One sentence, for previews and listings"
          className="text-foreground border-border placeholder:text-muted-foreground min-w-0 flex-1 rounded border bg-transparent px-2 py-1 text-sm outline-none"
        />
      </div>

      <div className="flex min-w-0 flex-1 items-center gap-2">
        <label
          className="text-muted-foreground w-16 shrink-0 text-xs"
          htmlFor={`${suggestionsId}-resource`}
        >
          Describes
        </label>
        <input
          id={`${suggestionsId}-resource`}
          value={facets.resource ?? ''}
          onChange={(event) => onChange?.(withOptional('resource', event.target.value))}
          placeholder="URL or path of the thing this document is about"
          className="text-foreground border-border placeholder:text-muted-foreground min-w-0 flex-1 rounded border bg-transparent px-2 py-1 text-sm outline-none"
        />
      </div>

      <div className="flex min-w-0 flex-1 items-center gap-2">
        <label
          className="text-muted-foreground w-16 shrink-0 text-xs"
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
              // The Enter that confirms an IME conversion is "accept this
              // word", not "finish this tag" — let it pass untouched.
              if (isImeComposingKeydown(event.nativeEvent)) return
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
