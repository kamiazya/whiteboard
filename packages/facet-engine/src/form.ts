/**
 * Tier 1 of the editor ladder: an editor DERIVED from the schema a facet
 * already declares, so a facet with no hand-written widget is still
 * visible and editable rather than invisible to everyone but an agent.
 *
 * The output is DATA in a closed control vocabulary — each surface renders
 * it with its own vessel, exactly as `contributions.ts` splits resolution
 * from rendering. The vocabulary is deliberately small: a schema it cannot
 * express answers `unsupported`, which is the honest signal that this facet
 * wants a real widget (tier 2) rather than half a payload in a form.
 */

import { z } from 'zod'

/**
 * The glyph vocabulary a spec may name — CLOSED, and owned by the core the
 * way contribution points are. A plugin picks from it; it cannot ship an
 * image or a component, which is what keeps a declared editor a
 * declaration rather than third-party UI code (the catalog-as-sandbox
 * principle of ADR-0013).
 */
export const FACET_GLYPHS = [
  'square',
  'circle',
  'diamond',
  'hexagon',
  'parallelogram',
  'cylinder',
  'none',
] as const
export type FacetGlyph = (typeof FACET_GLYPHS)[number]

export interface FacetSegmentedOption {
  /**
   * The value this segment writes. `null` CLEARS the facet — some defaults
   * are the absence of a value (a rect node stores no shape facet), and a
   * picker with no way to say that cannot express them.
   */
  readonly value: string | null
  readonly label: string
  readonly glyph?: FacetGlyph
}

export type FacetFormControl =
  | { readonly kind: 'text' }
  | { readonly kind: 'number' }
  | { readonly kind: 'toggle' }
  | { readonly kind: 'choice'; readonly options: readonly string[] }
  | { readonly kind: 'segmented'; readonly options: readonly FacetSegmentedOption[] }

export interface FacetFormField {
  readonly name: string
  /** Human-facing: the spec's label, else the field name. */
  readonly label: string
  readonly control: FacetFormControl
  readonly required: boolean
  /**
   * Whether this field belongs in a one-tap quick band (a context-menu
   * row) as well as the full editor. Only a spec can say so — a derived
   * field defaults to false, because a surface with room for one row
   * should not guess which of five fields deserves it.
   */
  readonly quick: boolean
}

/** What a plugin may declare about ONE field. Widget names are closed. */
export interface FacetFieldSpec {
  readonly widget: 'text' | 'number' | 'toggle' | 'choice' | 'segmented'
  readonly label?: string
  readonly quick?: boolean
  /** Required by `segmented`; ignored by the other widgets. */
  readonly options?: readonly FacetSegmentedOption[]
}

export interface FacetEditorSpec {
  readonly fields: Readonly<Record<string, FacetFieldSpec>>
}

export interface FacetFormVariant {
  /** The discriminant value this arm is selected by, and its heading. */
  readonly label: string
  readonly fields: readonly FacetFormField[]
}

export type FacetForm =
  | { readonly kind: 'fields'; readonly fields: readonly FacetFormField[] }
  | {
      readonly kind: 'variants'
      readonly discriminant: string
      readonly variants: readonly FacetFormVariant[]
    }
  | { readonly kind: 'unsupported' }

const UNSUPPORTED = { kind: 'unsupported' } as const

/** Peels `.optional()`/`.default()` wrappers off, reporting what it found. */
function unwrap(schema: z.ZodTypeAny): { inner: z.ZodTypeAny; required: boolean } {
  let inner = schema
  let required = true
  // A wrapper chain is short by construction; the loop terminates because
  // each step strips exactly one wrapper.
  while (inner instanceof z.ZodOptional || inner instanceof z.ZodDefault) {
    required = required && inner instanceof z.ZodDefault
    inner = inner.unwrap() as z.ZodTypeAny
  }
  return { inner, required }
}

function controlOf(schema: z.ZodTypeAny): FacetFormControl | undefined {
  if (schema instanceof z.ZodString) return { kind: 'text' }
  if (schema instanceof z.ZodNumber) return { kind: 'number' }
  if (schema instanceof z.ZodBoolean) return { kind: 'toggle' }
  if (schema instanceof z.ZodEnum) {
    const options = Object.values(schema.enum as Record<string, string>)
    return { kind: 'choice', options }
  }
  return undefined
}

/** The spec's control for a field, when it declares a richer one. */
function specControl(spec: FacetFieldSpec | undefined): FacetFormControl | undefined {
  if (spec === undefined) return undefined
  if (spec.widget === 'segmented') {
    return { kind: 'segmented', options: spec.options ?? [] }
  }
  if (spec.widget === 'choice') return undefined
  return { kind: spec.widget }
}

function fieldsOf(
  shape: Record<string, z.ZodTypeAny>,
  skip?: string,
  editor?: FacetEditorSpec,
): readonly FacetFormField[] | undefined {
  const fields: FacetFormField[] = []
  for (const [name, member] of Object.entries(shape)) {
    if (name === skip) continue
    const { inner, required } = unwrap(member)
    const derived = controlOf(inner)
    if (derived === undefined) return undefined
    const spec = editor?.fields[name]
    fields.push({
      name,
      label: spec?.label ?? name,
      control: specControl(spec) ?? derived,
      required,
      quick: spec?.quick ?? false,
    })
  }
  return fields
}

/** The discriminating literal of a union arm, when it has exactly one. */
function discriminantOf(shape: Record<string, z.ZodTypeAny>): [string, string] | undefined {
  for (const [name, member] of Object.entries(shape)) {
    if (member instanceof z.ZodLiteral) {
      const value = member.value
      if (typeof value === 'string') return [name, value]
    }
  }
  return undefined
}

export function deriveFacetForm(schema: z.ZodTypeAny, editor?: FacetEditorSpec): FacetForm {
  if (schema instanceof z.ZodObject) {
    const fields = fieldsOf(schema.shape as Record<string, z.ZodTypeAny>, undefined, editor)
    return fields === undefined ? UNSUPPORTED : { kind: 'fields', fields }
  }
  if (schema instanceof z.ZodUnion) {
    const arms = schema.options as readonly z.ZodTypeAny[]
    const variants: FacetFormVariant[] = []
    let discriminant: string | undefined
    for (const arm of arms) {
      if (!(arm instanceof z.ZodObject)) return UNSUPPORTED
      const shape = arm.shape as Record<string, z.ZodTypeAny>
      const found = discriminantOf(shape)
      if (found === undefined) return UNSUPPORTED
      const [name, label] = found
      if (discriminant !== undefined && discriminant !== name) return UNSUPPORTED
      discriminant = name
      // Two arms selected by the same literal cannot be told apart by a
      // picker, and the second would be unreachable.
      if (variants.some((variant) => variant.label === label)) return UNSUPPORTED
      const fields = fieldsOf(shape, name)
      if (fields === undefined) return UNSUPPORTED
      variants.push({ label, fields })
    }
    return discriminant === undefined ? UNSUPPORTED : { kind: 'variants', discriminant, variants }
  }
  return UNSUPPORTED
}

/**
 * Definition-time check for an editor spec, kept HERE because this module
 * owns what a form can express: a spec that names a field the schema does
 * not declare, or sits on a schema with no derivable form, is a
 * programmer error and throws like the rest of `defineFacet`'s grammar
 * checks.
 *
 * Lives in this module rather than the registry so the dependency stays
 * one-way — the registry may read the form layer, never the reverse.
 */
export function assertEditorSpecFits(
  facetName: string,
  schema: z.ZodTypeAny,
  editor: FacetEditorSpec,
): void {
  const form = deriveFacetForm(schema)
  if (form.kind !== 'fields') {
    throw new Error(
      `facet "${facetName}" declares an editor spec, but its schema has no derivable form`,
    )
  }
  const known = new Set(form.fields.map((field) => field.name))
  for (const name of Object.keys(editor.fields)) {
    if (!known.has(name)) {
      throw new Error(
        `facet "${facetName}" editor names field "${name}", which its schema does not declare`,
      )
    }
  }
}
