/**
 * The open half of a declared picker: a searchable catalog, and — where the
 * facet says so — any value its own schema accepts.
 *
 * `visual.symbol` accepted any single grapheme from the day it shipped and
 * offered five emoji, because every choice had to be written into a
 * definition that the renderer, the layout worker and the MCP server all
 * load. The restriction was never the schema. So the rows arrive through
 * the catalog's loader instead, and this draws them.
 *
 * Everything a person can PICK here goes through `FacetOption`, including
 * the band that chooses which section is showing — a category chooser is
 * "pick one of N" like any other, and giving it a tablist of its own would
 * have been the seventh spelling of the control the primitive exists to
 * end. What the two bands do not share is the radio NAME: the sections are
 * a view, the cells are the value, and one `name` for both would let the
 * browser treat a category as an answer.
 *
 * Styling follows this package's rule: inline values and the host's own
 * custom properties, never utility class names.
 */
import type {
  FacetPickerCatalogSection,
  FacetPickerCatalogSpec,
  FacetPickerOption,
  FacetRegistry,
} from '@kamiazya/whiteboard-facet-engine'
import { facetPayloadKey } from '@kamiazya/whiteboard-facet-engine'
import { type CSSProperties, useEffect, useMemo, useState } from 'react'
import { glyphIcon } from './glyph.js'
import { FacetOption, FacetOptionGroup } from './option-group.js'

const INK = 'var(--foreground, #171717)'
const MUTED = 'var(--muted-foreground, #737373)'
const LINE = 'var(--border, #e5e5e5)'
const SURFACE = 'var(--background, #ffffff)'
const DANGER = 'var(--destructive, #b3261e)'

const STACK: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.375rem',
  fontSize: '0.75rem',
}

const FIELD: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  border: `1px solid ${LINE}`,
  background: SURFACE,
  color: INK,
  borderRadius: '0.25rem',
  padding: '0.25rem 0.5rem',
  fontSize: '0.75rem',
}

/**
 * A fixed viewport with its own scrollbar, rather than a band that grows to
 * whatever the section holds. The largest section here is 388 cells; left
 * to itself it would push every row below the picker off the panel, and the
 * facet under this one would be unreachable without scrolling past a
 * screenful of faces.
 */
const SCROLLER: CSSProperties = {
  maxHeight: '9.5rem',
  overflowY: 'auto',
  // Room for the scrollbar, so the last column is not sitting under it.
  paddingRight: '0.125rem',
}

const CAPTION: CSSProperties = { color: MUTED, fontSize: '0.7rem' }

const ENTRY_ROW: CSSProperties = { display: 'flex', gap: '0.25rem', alignItems: 'center' }

const ENTRY_BUTTON: CSSProperties = {
  border: `1px solid ${LINE}`,
  background: 'transparent',
  color: INK,
  borderRadius: '0.25rem',
  padding: '0.25rem 0.5rem',
  fontSize: '0.75rem',
  cursor: 'pointer',
  flex: 'none',
}

/**
 * How many matches a search draws. A two-letter query matches hundreds, and
 * every one of them is a real DOM node with a real radio inside it — past a
 * screenful or two they cost render time to be scrolled past. The count
 * line below says when there are more, so the cap is visible rather than a
 * silently short answer.
 */
const MATCH_LIMIT = 96

/**
 * What a person picked here, most recent first, for as long as the tab is
 * open.
 *
 * Keyed by facet so two facets with catalogs do not share a history, and
 * held in the module because the picker unmounts every time the inspector
 * closes — state inside it would remember nothing past the first close,
 * which is the one moment recents exist for.
 *
 * ponytail: per-session and per-tab. The upgrade path is a storage seam the
 * vessel supplies (apps/web already persists user settings under
 * `whiteboard:user-settings:v2`), and it is worth taking when somebody
 * misses these across a reload rather than across a panel toggle.
 */
const RECENTS = new Map<string, readonly FacetPickerOption[]>()
const RECENT_LIMIT = 12

function remember(facetKey: string, option: FacetPickerOption): readonly FacetPickerOption[] {
  const key = facetPayloadKey(option.payload)
  const kept = (RECENTS.get(facetKey) ?? []).filter((seen) => facetPayloadKey(seen.payload) !== key)
  const next = [option, ...kept].slice(0, RECENT_LIMIT)
  RECENTS.set(facetKey, next)
  return next
}

/** Test seam: recents outlive a component, so a test has to be able to end them. */
export function clearFacetCatalogRecents(): void {
  RECENTS.clear()
}

/**
 * Every word a person might type to find this option.
 *
 * The CHARACTER is in there too, which is not redundant: pasting an emoji
 * into the search box is how somebody asks "is this one already here", and
 * matching only names answers no to a question whose answer is yes.
 */
function haystack(option: FacetPickerOption): string {
  const char = option.glyph?.kind === 'char' ? option.glyph.value : ''
  return `${option.label} ${(option.keywords ?? []).join(' ')} ${char}`.toLowerCase()
}

/**
 * Every term must appear, in any order and anywhere — so "face gr" finds
 * "grinning face" the way a person types it, which a prefix match on the
 * whole label does not.
 */
function matches(option: FacetPickerOption, terms: readonly string[]): boolean {
  const text = haystack(option)
  return terms.every((term) => text.includes(term))
}

export interface FacetCatalogPickerProps {
  readonly facetKey: string
  /** The facet's own display name, so each band can say which facet it is in. */
  readonly title: string
  readonly catalog: FacetPickerCatalogSpec
  readonly registry: FacetRegistry
  /** `facetPayloadKey` of what is stored, so a cell knows if it is the current one. */
  readonly selectedKey: string
  readonly onPick: (payload: unknown) => void
}

export function FacetCatalogPicker({
  facetKey,
  title,
  catalog,
  registry,
  selectedKey,
  onPick,
}: FacetCatalogPickerProps) {
  const [sections, setSections] = useState<readonly FacetPickerCatalogSection[]>([])
  const [failed, setFailed] = useState(false)
  const [active, setActive] = useState(0)
  const [query, setQuery] = useState('')
  const [typed, setTyped] = useState('')
  const [error, setError] = useState<string | undefined>(undefined)
  const [recent, setRecent] = useState<readonly FacetPickerOption[]>(
    () => RECENTS.get(facetKey) ?? [],
  )

  const load = catalog.load
  useEffect(() => {
    let live = true
    load().then(
      (loaded) => {
        if (live) setSections(loaded)
      },
      () => {
        // A catalog that will not load leaves the listed options and free
        // entry working, so the row degrades to what it was rather than to
        // nothing. Saying so beats an empty band a person waits at.
        if (live) setFailed(true)
      },
    )
    return () => {
      live = false
    }
  }, [load])

  const terms = useMemo(() => query.trim().toLowerCase().split(/\s+/).filter(Boolean), [query])

  const found = useMemo(() => {
    if (terms.length === 0) return undefined
    const hits: FacetPickerOption[] = []
    for (const section of sections) {
      for (const option of section.options) {
        if (matches(option, terms)) hits.push(option)
      }
    }
    return hits
  }, [sections, terms])

  const pick = (option: FacetPickerOption) => {
    setError(undefined)
    setRecent(remember(facetKey, option))
    onPick(option.payload)
  }

  const entry = catalog.entry
  const submitEntry = () => {
    if (entry === undefined) return
    const text = typed.trim()
    if (text === '') return
    const payload = { ...entry.payload, [entry.field]: text }
    // The facet's own schema decides, at the same boundary every other
    // write crosses. That is what makes free entry safe to offer at all:
    // nothing here knows what `visual.symbol` will accept, and it does not
    // need to.
    const result = registry.validateFacetWrite(facetKey, payload)
    if (!result.ok) {
      setError(result.message)
      return
    }
    setTyped('')
    pick({ payload: result.value, label: text, glyph: { kind: 'char', value: text } })
  }

  const shown = found ?? sections[active]?.options ?? []
  const capped = shown.slice(0, MATCH_LIMIT)

  return (
    <div style={STACK}>
      <input
        type="search"
        aria-label={catalog.label}
        placeholder={catalog.label}
        style={FIELD}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />

      {recent.length > 0 && (
        <>
          {/* The one WORD in a picker that is otherwise all pictures, and it
              earns its place: a band of loose symbols above a search box is
              read as more of the row above it. Every other band here is
              named by what it draws — a category by its own first symbol, a
              value by being the value — and "recently used" is the one thing
              a picture cannot say about a picture. */}
          <span style={CAPTION}>Recent</span>
          <FacetOptionGroup label={`${title} recently used`} layout="grid">
            {recent.map((option) => (
              <FacetOption
                key={facetPayloadKey(option.payload)}
                name={`facet-catalog-${facetKey}`}
                layout="grid"
                label={option.label}
                selected={facetPayloadKey(option.payload) === selectedKey}
                onSelect={() => pick(option)}
                {...glyphProp(option, registry)}
              />
            ))}
          </FacetOptionGroup>
        </>
      )}

      {failed && <span style={CAPTION}>Could not load {catalog.label.toLowerCase()}.</span>}

      {found === undefined && sections.length > 1 && (
        <FacetOptionGroup label={`${title} categories`} layout="chips">
          {sections.map((section, index) => (
            <FacetOption
              key={section.label}
              // A DIFFERENT radio name from the cells below: these choose
              // what is on screen, not what the facet holds.
              name={`facet-catalog-section-${facetKey}`}
              layout="chips"
              label={section.label}
              selected={index === active}
              onSelect={() => setActive(index)}
              // The band's own picture when it declares one, and its first
              // option's only as a fallback — a catalog that says nothing
              // about how its categories look still gets a chooser rather
              // than a row of words.
              {...glyphProp(section.glyph === undefined ? section.options[0] : section, registry)}
            />
          ))}
        </FacetOptionGroup>
      )}

      {/* Not drawn before the rows arrive: an empty band labelled with the
          facet's own name is a second group called "Symbol" beside the
          listed one, which tells a screen-reader user nothing about which
          of the two they are in. */}
      {(found !== undefined || sections.length > 0) && (
        <div style={SCROLLER}>
          <FacetOptionGroup
            label={
              found === undefined
                ? `${title}: ${sections[active]?.label ?? ''}`
                : `${title} matches`
            }
            layout="grid"
          >
            {capped.map((option) => (
              <FacetOption
                key={`${option.label}-${facetPayloadKey(option.payload)}`}
                name={`facet-catalog-${facetKey}`}
                layout="grid"
                label={option.label}
                selected={facetPayloadKey(option.payload) === selectedKey}
                onSelect={() => pick(option)}
                {...glyphProp(option, registry)}
              />
            ))}
          </FacetOptionGroup>
        </div>
      )}

      {found !== undefined && (
        <span role="status" style={CAPTION}>
          {found.length === 0
            ? `No match for “${query.trim()}”`
            : found.length > capped.length
              ? `${capped.length} of ${found.length} matches`
              : `${found.length} ${found.length === 1 ? 'match' : 'matches'}`}
        </span>
      )}

      {entry !== undefined && (
        <div style={ENTRY_ROW}>
          <input
            type="text"
            aria-label={entry.label}
            {...(entry.placeholder === undefined ? {} : { placeholder: entry.placeholder })}
            style={FIELD}
            value={typed}
            onChange={(event) => {
              setTyped(event.target.value)
              setError(undefined)
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return
              // The row sits inside the inspector's own form chrome on some
              // vessels; Enter must apply the value, not submit that.
              event.preventDefault()
              submitEntry()
            }}
          />
          <button type="button" style={ENTRY_BUTTON} onClick={submitEntry}>
            Use
          </button>
        </div>
      )}

      {error !== undefined && (
        <span role="alert" style={{ ...CAPTION, color: DANGER }}>
          {error}
        </span>
      )}
    </div>
  )
}

/** Spread rather than passed: `glyph` is optional and `undefined` is not a value. */
function glyphProp(
  source: { readonly glyph?: FacetPickerOption['glyph'] } | undefined,
  registry: FacetRegistry,
): { glyph?: ReturnType<typeof glyphIcon> } {
  const glyph = glyphIcon(source?.glyph, registry)
  return glyph === undefined ? {} : { glyph }
}
