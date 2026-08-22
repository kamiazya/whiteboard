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

export interface FacetFormPanelProps {
  readonly node: SpatialNode
  readonly registry: FacetRegistry
  /** `undefined` payload clears the facet, matching set-node-facet. */
  readonly onWrite: (key: string, payload: unknown) => void
  /** Present when mounted as an overlay; absent renders the bare body. */
  readonly onClose?: () => void
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
}: {
  readonly facetKey: string
  /** Facet title, so the accessible name says WHICH facet's field this is. */
  readonly title: string
  readonly field: FacetFormField
  readonly value: unknown
  readonly onChange: (next: unknown) => void
}) {
  // Scoped by facet: two facets may declare the same field name, and a
  // duplicate id would point every label at the first input. The
  // accessible NAME is qualified for the same reason — a dialog with two
  // controls both called "kind" tells a screen-reader user nothing.
  const id = `facet-field-${facetKey}-${field.name}`
  const name = `${title} ${field.label}`
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
  const [draft, setDraft] = useState<Draft>(() => initialDraft(stored))
  const [error, setError] = useState<string | undefined>(undefined)
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

  const save = () => {
    const payload =
      form.kind === 'variants' && activeVariant !== undefined
        ? { ...prune(draft), [form.discriminant]: activeVariant.label }
        : prune(draft)
    const result = registry.validateFacetWrite(facetKey, payload)
    if (!result.ok) {
      setError(result.message)
      return
    }
    setError(undefined)
    onWrite(facetKey, result.value)
  }

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium">{title}</span>
      {form.kind === 'variants' && (
        <label
          htmlFor={`facet-variant-${facetKey}`}
          className="flex items-center justify-between gap-2 text-xs"
        >
          <span className="text-muted-foreground">{form.discriminant}</span>
          <select
            id={`facet-variant-${facetKey}`}
            aria-label={`${title} ${form.discriminant}`}
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
          className="flex items-center justify-between gap-2 text-xs"
        >
          <span className={cn('text-muted-foreground', field.required && 'font-medium')}>
            {field.label}
          </span>
          <FieldInput
            facetKey={facetKey}
            title={title}
            field={field}
            value={draft[field.name]}
            onChange={(next) => set(field.name, next)}
          />
        </label>
      ))}
      {error !== undefined && (
        <span role="alert" className="text-[0.7rem] text-destructive">
          {error}
        </span>
      )}
      <span className="flex items-center gap-1">
        <button
          type="button"
          className="rounded border border-border px-2 py-0.5 text-xs hover:bg-accent"
          onClick={save}
        >
          Save {title}
        </button>
        {stored !== undefined && (
          <button
            type="button"
            className="rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent"
            onClick={() => onWrite(facetKey, undefined)}
          >
            Clear {title}
          </button>
        )}
      </span>
    </div>
  )
}

export function FacetFormPanel({ node, registry, onWrite, onClose }: FacetFormPanelProps) {
  const groups = resolveFacetContributions(registry, 'contextMenu.node.properties')
  const stored = storedFacets(node)
  const body = (
    <div className="flex flex-col gap-3">
      {groups.map((group) => (
        <div key={group.namespace} className="flex flex-col gap-2">
          <span className="text-[0.65rem] font-medium tracking-wide text-muted-foreground">
            {group.displayName}
          </span>
          {group.facets.map((facet) => (
            <FacetEditor
              // Keyed by NODE too: a draft belongs to the node it was typed
              // against. Retargeting the panel without this reuses the
              // instance, so an abandoned edit on one node would be shown —
              // and saved — as another node's value.
              key={`${node.id}:${facet.key}`}
              facetKey={facet.key}
              title={`${group.displayName} ${facet.definition.name}`}
              form={deriveFacetForm(facet.definition.schema)}
              stored={stored[facet.key]}
              registry={registry}
              onWrite={onWrite}
            />
          ))}
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
      role="dialog"
      aria-label="Facets"
      className="rounded-md border bg-background p-3 shadow-lg"
      style={{
        position: 'absolute',
        zIndex: 30,
        left: '50%',
        top: '35%',
        transform: 'translate(-50%, -50%)',
        maxHeight: '60%',
        overflowY: 'auto',
        width: 'max-content',
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          onClose()
        }
      }}
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
