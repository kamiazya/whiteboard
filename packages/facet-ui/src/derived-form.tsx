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
import {
  deriveFacetForm,
  type FacetForm,
  type FacetFormField,
  type FacetRegistry,
} from '@kamiazya/whiteboard-facet-engine'
import { type CSSProperties, useState } from 'react'
import { glyphIcon } from './glyph.js'

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
const CONTROL: CSSProperties = {
  border: `1px solid ${LINE}`,
  background: SURFACE,
  color: INK,
  borderRadius: '0.25rem',
  padding: '0.25rem 0.5rem',
  fontSize: '0.75rem',
}
const SEGMENT: CSSProperties = {
  ...CONTROL,
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.25rem',
  padding: '0.25rem 0.375rem',
  cursor: 'pointer',
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
  onChange,
  onClear,
}: {
  readonly facetKey: string
  /** Facet title, so the accessible name says WHICH facet's field this is. */
  readonly title: string
  readonly field: FacetFormField
  readonly value: unknown
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
    return (
      <span
        id={id}
        role="radiogroup"
        aria-label={name}
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'flex-end',
          gap: '0.125rem',
        }}
      >
        {/* Real radios rather than buttons wearing the role: the keyboard
            behaviour a segmented control needs comes free with the element. */}
        {field.control.options.map((option) => {
          const glyph = glyphIcon(option.glyph)
          return (
            // A declared glyph is DRAWN, the way the quick band draws it —
            // a shape picker spelling "Parallelogram" is both wider and
            // slower to read than the shape itself. The word stays as the
            // accessible name, so nothing is lost for a screen reader, and
            // an option with no glyph still shows its label.
            <label
              key={option.label}
              title={glyph === undefined ? undefined : option.label}
              style={SEGMENT}
            >
              <input
                type="radio"
                name={id}
                aria-label={option.label}
                checked={option.value === null ? value === undefined : value === option.value}
                onChange={() => (option.value === null ? onClear() : onChange(option.value))}
              />
              {glyph === undefined ? (
                option.label
              ) : (
                <span
                  aria-hidden="true"
                  style={{ display: 'inline-flex', width: '1rem', height: '1rem' }}
                >
                  {glyph}
                </span>
              )}
            </label>
          )
        })}
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
  // Derived HERE rather than passed in: a caller computing the form itself
  // is a caller that can compute it differently, which is the drift this
  // move exists to close.
  const definition = registry.plugins
    .flatMap((plugin) =>
      plugin.facets.map((facet) => [`${plugin.id}.${facet.name}/${facet.version}`, facet] as const),
    )
    .find(([key]) => key === facetKey)?.[1]
  const form: FacetForm =
    definition === undefined
      ? { kind: 'unsupported' }
      : deriveFacetForm(definition.schema, definition.editor)
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
      {fields.map((field) => (
        <label
          key={field.name}
          htmlFor={`facet-field-${facetKey}-${field.name}`}
          // Wraps for the same reason the menu's option rows do: a segmented
          // control with six options does not fit a phone beside its label,
          // and the options past the edge are the ones nobody can tap.
          style={ROW}
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
            onChange={(next) => change(field, next)}
            onClear={() => onWrite(facetKey, undefined)}
          />
        </label>
      ))}
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
