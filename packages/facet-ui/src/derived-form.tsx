/**
 * Tiers 1 and 2 of the editor ladder, rendered: a facet with no component of
 * its own gets its form from the schema it already declares, refined by any
 * `editor` spec on the definition.
 *
 * This lives beside the plugin surface rather than in a vessel because a
 * DECLARED editor should look the same wherever it is shown. While it lived
 * in apps/web, a second surface would have had to reimplement the
 * derivation to render the same declaration.
 *
 * Styling follows this package's rule: values and the host's own custom
 * properties, never utility class names — a class named inside a workspace
 * package is never generated and fails silently.
 */
import type { FacetForm, FacetFormField, FacetRegistry } from '@kamiazya/whiteboard-facet-engine'
import { facetPayloadKey } from '@kamiazya/whiteboard-facet-engine'
import { type CSSProperties, useState } from 'react'
import { FacetCatalogPicker } from './catalog-picker.js'
import { glyphIcon } from './glyph.js'
import { FacetOption, FacetOptionGroup } from './option-group.js'

/** The host supplies these; the literal is what a bare page falls back to. */
const INK = 'var(--foreground, #171717)'
const MUTED = 'var(--muted-foreground, #737373)'
const LINE = 'var(--border, #e5e5e5)'
const SURFACE = 'var(--background, #ffffff)'
const ACCENT = 'var(--accent, #f2f2f2)'
const DANGER = 'var(--destructive, #b3261e)'

const ROW: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  justifyContent: 'space-between',
  columnGap: '0.5rem',
  rowGap: '0.25rem',
  fontSize: '0.75rem',
}
/** A card grid takes the whole width, so its name sits above rather than beside. */
const STACKED_ROW: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'stretch',
  gap: '0.375rem',
  fontSize: '0.75rem',
}
const CONTROL: CSSProperties = {
  border: `1px solid ${LINE}`,
  background: SURFACE,
  color: INK,
  borderRadius: '0.25rem',
  padding: '0.25rem 0.5rem',
  fontSize: '0.75rem',
}
const BUTTON: CSSProperties = {
  border: `1px solid ${LINE}`,
  background: 'transparent',
  color: INK,
  borderRadius: '0.25rem',
  padding: '0.125rem 0.5rem',
  fontSize: '0.75rem',
  cursor: 'pointer',
}
const GHOST: CSSProperties = { ...BUTTON, border: '1px solid transparent', color: MUTED }

type Draft = Record<string, unknown>

/** The draft a form starts from: the stored payload, or empty. */
function initialDraft(stored: unknown): Draft {
  return typeof stored === 'object' && stored !== null ? { ...(stored as Draft) } : {}
}

function FieldInput({
  facetKey,
  title,
  field,
  value,
  registry,
  onChange,
  onClear,
}: {
  readonly facetKey: string
  /** Facet title, so the accessible name says WHICH facet's field this is. */
  readonly title: string
  readonly field: FacetFormField
  readonly value: unknown
  /** Only the `asset` glyph arm needs it — it resolves registered geometry. */
  readonly registry: FacetRegistry
  readonly onChange: (next: unknown) => void
  /**
   * A segmented option carrying `value: null` means the facet should not
   * exist — a whole-facet statement, not a field value. Staging it in the
   * draft would submit a payload missing a required field, so it takes the
   * same immediate path the Clear button beside it already takes.
   */
  readonly onClear: () => void
}) {
  // Scoped by facet: two facets may declare the same field name, and a
  // duplicate id would point every label at the first input. The
  // accessible NAME is qualified for the same reason — a dialog with two
  // controls both called "kind" tells a screen-reader user nothing.
  const id = `facet-field-${facetKey}-${field.name}`
  // A single-field facet often labels its field the way the facet is named
  // ("Shape" / "Shape"); saying it twice tells a reader nothing.
  const name = field.label === title ? title : `${title} ${field.label}`
  if (field.control.kind === 'toggle') {
    return (
      <input
        id={id}
        aria-label={name}
        type="checkbox"
        checked={value === true}
        onChange={(event) => onChange(event.target.checked)}
      />
    )
  }
  if (field.control.kind === 'segmented') {
    // Bound before the map: TypeScript re-widens `field.control` inside a
    // callback, and the layout is read there.
    const control = field.control
    // NOT wrapped in anything labelable, and the caller does not wrap this
    // arm in a `<label>` either (see the field list below). A `<label>`
    // inside a `<label>` is invalid, and the browser resolves a click on
    // the inner one against the OUTER label's control — so the option a
    // person pressed is not the one that takes the press. The group's own
    // `aria-label` is what names it.
    return (
      // A card grid must fill the row it stands in, and an inline span does
      // not — so the wrapper becomes a block when it holds one.
      <span id={id} {...(control.layout === 'cards' ? { style: { display: 'block' } } : {})}>
        <FacetOptionGroup label={name} layout={control.layout}>
          {control.options.map((option) => (
            <FacetOption
              key={option.label}
              name={id}
              layout={control.layout}
              label={option.label}
              selected={option.value === null ? value === undefined : value === option.value}
              onSelect={() => (option.value === null ? onClear() : onChange(option.value))}
              {...(glyphIcon(option.glyph, registry) === undefined
                ? {}
                : { glyph: glyphIcon(option.glyph, registry) })}
            />
          ))}
        </FacetOptionGroup>
      </span>
    )
  }
  if (field.control.kind === 'choice') {
    return (
      <select
        id={id}
        aria-label={name}
        style={CONTROL}
        value={typeof value === 'string' ? value : ''}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">—</option>
        {field.control.options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    )
  }
  return (
    <input
      id={id}
      aria-label={name}
      type={field.control.kind === 'number' ? 'number' : 'text'}
      style={CONTROL}
      value={value === undefined || value === null ? '' : String(value)}
      onChange={(event) =>
        onChange(
          field.control.kind === 'number'
            ? event.target.value === ''
              ? undefined
              : Number(event.target.value)
            : event.target.value,
        )
      }
    />
  )
}

/** Drops keys the human left empty, so an optional field stays absent. */
function prune(draft: Draft): Draft {
  return Object.fromEntries(
    Object.entries(draft).filter(([, value]) => value !== undefined && value !== ''),
  )
}

export interface DerivedFacetFormProps {
  /** The facet's current storage key, `{namespace}.{name}/v{n}`. */
  readonly facetKey: string
  /** What to call it on screen — the facet's own `displayName`. */
  readonly title: string
  readonly stored: unknown
  readonly registry: FacetRegistry
  /** `undefined` payload clears the facet. */
  readonly onWrite: (key: string, payload: unknown) => void
}

export function DerivedFacetForm({
  facetKey,
  title,
  stored,
  registry,
  onWrite,
}: DerivedFacetFormProps) {
  // Asked of the REGISTRY rather than derived here: a caller computing the
  // form itself is a caller that can compute it differently, and this is
  // no longer the only caller — the vessel that draws a facet whose
  // effective value only it can resolve asks the same question.
  const form: FacetForm = registry.facetForm(facetKey)
  // The draft follows the STORED payload: a Clear (or any write from
  // elsewhere) must empty the form, or the next Save would restore what
  // the human just removed. `useState`'s initializer runs once, so the
  // seed is compared against what it was seeded from.
  const [draft, setDraft] = useState<Draft>(() => initialDraft(stored))
  const [seed, setSeed] = useState(stored)
  const [error, setError] = useState<string | undefined>(undefined)
  if (seed !== stored) {
    setSeed(stored)
    setDraft(initialDraft(stored))
    setError(undefined)
  }
  const set = (name: string, value: unknown) => setDraft((prev) => ({ ...prev, [name]: value }))

  if (form.kind === 'unsupported') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
        <span style={{ fontSize: '0.75rem', color: MUTED }}>{title}</span>
        <pre
          style={{
            overflowX: 'auto',
            borderRadius: '0.25rem',
            background: ACCENT,
            padding: '0.25rem',
            fontSize: '0.7rem',
          }}
        >
          {stored === undefined ? '—' : JSON.stringify(stored)}
        </pre>
        <span style={{ fontSize: '0.7rem', color: MUTED }}>
          This facet needs its own editor; shown read-only.
        </span>
      </div>
    )
  }

  /**
   * A PICKER is the whole form: one control, whole payloads, and the
   * facet's absence as an ordinary option rather than a button beside it.
   *
   * That last part is why there is no Clear here. The derived form used to
   * offer one whenever anything was stored, and the theme row ended up
   * with two ways to say "no theme" — a `Default` segment and a `Clear`
   * whose visible text named nothing it would clear. One control, one way.
   */
  if (form.kind === 'picker') {
    // Keyed rather than stringified directly: a stored payload's key order
    // is its WRITER's, and `wb_facet_set` or a document authored elsewhere
    // has no reason to match this declaration's. Compared raw, such a value
    // matches no option and the picker draws with nothing selected.
    const current = facetPayloadKey(stored)
    // The same shape a field of the same layout takes, so a panel holding
    // both does not lay out two rows two ways: a CHIP row is name-left /
    // options-right, and a CARD row is a full-width grid under its name,
    // because cells that share a line with a label are no longer cells.
    //
    // A CATALOG stacks for the same reason a card grid does, whatever the
    // listed options' own layout is: a search field and a scrolling grid
    // are the width of the panel, and the listed chips are the top of that
    // block rather than a row beside a name.
    const stacked = form.layout === 'cards' || form.catalog !== undefined
    return (
      <div style={stacked ? STACKED_ROW : ROW}>
        <span style={{ color: MUTED }}>{title}</span>
        <FacetOptionGroup label={title} layout={form.layout}>
          {form.options.map((option) => {
            const glyph = glyphIcon(option.glyph, registry)
            return (
              <FacetOption
                key={option.label}
                name={`facet-picker-${facetKey}`}
                layout={form.layout}
                label={option.label}
                selected={facetPayloadKey(option.payload) === current}
                // Straight through the write path, the same as every other
                // control here: `null` clears, anything else is validated
                // before it is stored. A picker payload was already parsed
                // at definition time, so this is the second of two nets.
                onSelect={() =>
                  onWrite(facetKey, option.payload === null ? undefined : option.payload)
                }
                {...(glyph === undefined ? {} : { glyph })}
              />
            )
          })}
        </FacetOptionGroup>
        {form.catalog !== undefined && (
          <FacetCatalogPicker
            facetKey={facetKey}
            title={title}
            catalog={form.catalog}
            registry={registry}
            selectedKey={current}
            // Straight through the same door the listed options take. The
            // catalog's own rows were never parsed at definition time (a
            // loader is not loaded then), so this write is the only net
            // under them — and it is the same one every other write
            // crosses.
            onPick={(payload) => onWrite(facetKey, payload === null ? undefined : payload)}
          />
        )}
      </div>
    )
  }

  const activeVariant =
    form.kind === 'variants'
      ? (form.variants.find((variant) => variant.label === draft[form.discriminant]) ??
        form.variants[0])
      : undefined
  const fields = form.kind === 'fields' ? form.fields : (activeVariant?.fields ?? [])

  const commit = (next: Draft) => {
    const payload =
      form.kind === 'variants' && activeVariant !== undefined
        ? { ...prune(next), [form.discriminant]: activeVariant.label }
        : prune(next)
    const result = registry.validateFacetWrite(facetKey, payload)
    if (!result.ok) {
      setError(result.message)
      return
    }
    setError(undefined)
    onWrite(facetKey, result.value)
  }

  /**
   * A CHOICE applies on pick, the way the same facet's quick band does.
   * Staging it behind Save gave one facet two behaviours depending on which
   * surface you reached it from. Free entry has no moment mid-typing that
   * means "done", so a facet carrying one keeps its Save button.
   */
  const applies = (field: FacetFormField) =>
    field.control.kind !== 'text' && field.control.kind !== 'number'
  const needsSave = fields.some((field) => !applies(field))
  const change = (field: FacetFormField, value: unknown) => {
    const next = { ...draft, [field.name]: value }
    setDraft(next)
    if (applies(field)) commit(next)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
      <span style={{ fontSize: '0.75rem', fontWeight: 500 }}>{title}</span>
      {form.kind === 'variants' && (
        <label htmlFor={`facet-variant-${facetKey}`} style={ROW}>
          <span style={{ color: MUTED }}>{form.discriminantLabel}</span>
          <select
            id={`facet-variant-${facetKey}`}
            aria-label={`${title} ${form.discriminantLabel}`}
            style={CONTROL}
            value={activeVariant?.label ?? ''}
            onChange={(event) => set(form.discriminant, event.target.value)}
          >
            {form.variants.map((variant) => (
              <option key={variant.label} value={variant.label}>
                {variant.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {fields.map((field) => {
        // A SEGMENTED field is its own radio group and carries its own
        // accessible name, so it takes a plain wrapper: nesting its option
        // labels inside a field `<label>` is invalid HTML, and a click on an
        // inner label resolves against the outer one's control. Every other
        // control here is a single labelable element, which is what a
        // `<label htmlFor>` is for.
        const Row = field.control.kind === 'segmented' ? 'div' : 'label'
        const cards = field.control.kind === 'segmented' && field.control.layout === 'cards'
        return (
          <Row
            key={field.name}
            {...(Row === 'label' ? { htmlFor: `facet-field-${facetKey}-${field.name}` } : {})}
            // Wraps for the same reason the menu's option rows do: a segmented
            // control with six options does not fit a phone beside its label,
            // and the options past the edge are the ones nobody can tap. A
            // CARD grid takes the whole width instead, so its name sits above.
            style={cards ? STACKED_ROW : ROW}
          >
            {/* A single-field facet usually labels its field the way the facet
                itself is named ("Shape" under "Shape"). Printing it twice adds
                a line and says nothing; the accessible name still carries it. */}
            <span style={{ color: MUTED, fontWeight: field.required ? 500 : 400 }}>
              {field.label === title ? '' : field.label}
            </span>
            <FieldInput
              facetKey={facetKey}
              title={title}
              field={field}
              value={draft[field.name]}
              registry={registry}
              onChange={(next) => change(field, next)}
              onClear={() => onWrite(facetKey, undefined)}
            />
          </Row>
        )
      })}
      {error !== undefined && (
        <span role="alert" style={{ fontSize: '0.7rem', color: DANGER }}>
          {error}
        </span>
      )}
      <span style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
        {/* The visible words say what the button does; WHICH facet is the
            heading's job on screen and the accessible name's for a reader
            who has no heading in view. */}
        {needsSave && (
          <button
            type="button"
            aria-label={`Save ${title}`}
            style={BUTTON}
            onClick={() => commit(draft)}
          >
            Save
          </button>
        )}
        {stored !== undefined && (
          <button
            type="button"
            aria-label={`Clear ${title}`}
            style={GHOST}
            onClick={() => onWrite(facetKey, undefined)}
          >
            Clear
          </button>
        )}
      </span>
    </div>
  )
}
