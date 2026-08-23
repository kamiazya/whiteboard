/**
 * The tier-1 editor's vessel: every facet a node can carry, rendered from
 * the form the engine derives from each schema.
 *
 * This is what closes the gap a quick band leaves — an agent may write any
 * registered facet through `wb_facet_set`, and before this panel a facet
 * with no hand-written widget was invisible to the person looking at the
 * canvas. A facet whose schema is outside the derivable vocabulary shows
 * its stored value read-only and says so, rather than pretending to edit
 * half of it.
 *
 * Writes go through the REGISTRY's own validation, so this panel can never
 * store a payload `wb_facet_set` would refuse.
 */
import {
  deriveFacetForm,
  type FacetForm,
  type FacetFormField,
  type FacetRegistry,
  resolveFacetContributions,
} from '@kamiazya/whiteboard-facet-engine'
import type { SpatialNode } from '@kamiazya/whiteboard-model'
import { useState } from 'react'
import { cn } from '@/lib/utils'
import { glyphIcon } from './glyph.js'
import { type FacetEditorWidget, NODE_FACET_EDITORS } from './index.js'

export interface FacetFormPanelProps {
  /**
   * The node whose stored values the panel SHOWS. Writes go to the whole
   * selection (see `onWrite`) — the same split the context-menu bands had,
   * where the row reflected the node you opened on and applied to every
   * selected node.
   */
  readonly node: SpatialNode
  /**
   * Tier-3 editors by facet key. A facet with one registered renders it
   * instead of the derived form — the picker the declared vocabulary
   * cannot yet express (today: the icon-plus-emoji badge picker).
   */
  readonly editors?: Readonly<Record<string, FacetEditorWidget>>
  readonly registry: FacetRegistry
  /** `undefined` payload clears the facet, matching set-node-facet. */
  readonly onWrite: (key: string, payload: unknown) => void
  /** Present when mounted as an overlay; absent renders the bare body. */
  readonly onClose?: () => void
  /**
   * Where the inspector sits. Follows the context menu's breakpoint so the
   * two agree about what a narrow editor is.
   */
  readonly variant?: 'dock' | 'sheet'
}

type Draft = Record<string, unknown>

const storedFacets = (node: SpatialNode): Record<string, unknown> =>
  node['x-whiteboard']?.facets ?? {}

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
  const common = 'rounded border border-border bg-background px-2 py-1 text-xs'
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
        className="flex flex-wrap items-center justify-end gap-0.5"
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
              className={cn(common, 'flex items-center gap-1 px-1.5')}
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
                <span aria-hidden="true" className="[&>svg]:size-4">
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
        className={common}
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
      className={common}
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

function FacetEditor({
  facetKey,
  title,
  form,
  stored,
  registry,
  onWrite,
}: {
  readonly facetKey: string
  readonly title: string
  readonly form: FacetForm
  readonly stored: unknown
  readonly registry: FacetRegistry
  readonly onWrite: (key: string, payload: unknown) => void
}) {
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
      <div className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">{title}</span>
        <pre className="overflow-x-auto rounded bg-muted p-1 text-[0.7rem]">
          {stored === undefined ? '—' : JSON.stringify(stored)}
        </pre>
        <span className="text-[0.7rem] text-muted-foreground">
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
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium">{title}</span>
      {form.kind === 'variants' && (
        <label
          htmlFor={`facet-variant-${facetKey}`}
          className="flex items-center justify-between gap-2 text-xs"
        >
          <span className="text-muted-foreground">{form.discriminantLabel}</span>
          <select
            id={`facet-variant-${facetKey}`}
            aria-label={`${title} ${form.discriminantLabel}`}
            className="rounded border border-border bg-background px-2 py-1 text-xs"
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
          className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-xs"
        >
          {/* A single-field facet usually labels its field the way the facet
              itself is named ("Shape" under "Shape"). Printing it twice adds
              a line and says nothing; the accessible name still carries it. */}
          <span className={cn('text-muted-foreground', field.required && 'font-medium')}>
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
        <span role="alert" className="text-[0.7rem] text-destructive">
          {error}
        </span>
      )}
      <span className="flex items-center gap-1">
        {/* The visible words say what the button does; WHICH facet is the
            heading's job on screen and the accessible name's for a reader
            who has no heading in view. */}
        {needsSave && (
          <button
            type="button"
            aria-label={`Save ${title}`}
            className="rounded border border-border px-2 py-0.5 text-xs hover:bg-accent"
            onClick={() => commit(draft)}
          >
            Save
          </button>
        )}
        {stored !== undefined && (
          <button
            type="button"
            aria-label={`Clear ${title}`}
            className="rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent"
            onClick={() => onWrite(facetKey, undefined)}
          >
            Clear
          </button>
        )}
      </span>
    </div>
  )
}

export function FacetFormPanel({
  node,
  registry,
  onWrite,
  onClose,
  editors = NODE_FACET_EDITORS,
  variant = 'dock',
}: FacetFormPanelProps) {
  const groups = resolveFacetContributions(registry, 'inspector.node')
  const stored = storedFacets(node)
  const body = (
    <div className="flex flex-col gap-3">
      {groups.map((group) => (
        <div key={group.namespace} className="flex flex-col gap-2">
          <span className="text-[0.65rem] font-medium tracking-wide text-muted-foreground">
            {group.displayName}
          </span>
          {group.facets.map((facet) =>
            editors[facet.key] !== undefined ? (
              <div key={`${node.id}:${facet.key}`} className="flex flex-col gap-1.5">
                <span className="text-xs font-medium">{facet.definition.displayName}</span>
                {editors[facet.key]?.({
                  value: stored[facet.key],
                  // Straight through the registry, exactly like the derived
                  // form's own writer — a hand-written editor gets no shorter
                  // path to storage than a declared one.
                  write: (payload) => {
                    if (payload === undefined) return onWrite(facet.key, undefined)
                    const result = registry.validateFacetWrite(facet.key, payload)
                    if (result.ok) onWrite(facet.key, result.value)
                  },
                })}
              </div>
            ) : (
              <FacetEditor
                // Keyed by NODE too: a draft belongs to the node it was typed
                // against. Retargeting the panel without this reuses the
                // instance, so an abandoned edit on one node would be shown —
                // and saved — as another node's value.
                key={`${node.id}:${facet.key}`}
                facetKey={facet.key}
                title={facet.definition.displayName}
                form={deriveFacetForm(facet.definition.schema, facet.definition.editor)}
                stored={stored[facet.key]}
                registry={registry}
                onWrite={onWrite}
              />
            ),
          )}
        </div>
      ))}
    </div>
  )
  if (onClose === undefined) return <div data-testid="facet-form-panel">{body}</div>
  // Same vessel convention as the other canvas overlays: hand-rolled and
  // inline-positioned, so it behaves identically where the app stylesheet
  // is absent (browser-mode component tests), and marked
  // `data-editor-overlay` so canvas gesture handlers ignore presses inside.
  return (
    <div
      data-editor-overlay
      data-testid="facet-form-panel"
      // NOT a dialog: it stays open while you select other nodes, and taking
      // focus would pull it off the canvas every time it opened. `complementary`
      // is the landmark for a panel that supports the main surface rather than
      // interrupting it.
      role="complementary"
      aria-label="Facets"
      className={cn(
        'bg-background p-3 shadow-lg',
        variant === 'sheet' ? 'rounded-t-xl border-t' : 'rounded-md border',
      )}
      // A centred box cannot be non-modal: it covers the canvas, and
      // `data-editor-overlay` makes it swallow the press that would have
      // selected the node underneath. Measured while trying to select a node
      // the panel was sitting on top of — the click never reached it.
      style={
        variant === 'sheet'
          ? {
              position: 'absolute',
              zIndex: 30,
              left: 0,
              right: 0,
              bottom: 0,
              maxHeight: '55%',
              overflowY: 'auto',
              paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))',
            }
          : {
              position: 'absolute',
              zIndex: 30,
              right: 8,
              top: 8,
              width: 'min(22rem, calc(100% - 16px))',
              maxHeight: 'calc(100% - 16px)',
              overflowY: 'auto',
            }
      }
    >
      <div className="flex items-center justify-between gap-4 pb-2">
        <span className="text-xs font-medium">Facets</span>
        <button
          type="button"
          aria-label="Close facets"
          className="rounded px-2 text-xs text-muted-foreground hover:bg-accent"
          onClick={onClose}
        >
          Done
        </button>
      </div>
      {body}
    </div>
  )
}
