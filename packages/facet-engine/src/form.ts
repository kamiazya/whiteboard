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

export type FacetFormControl =
  | { readonly kind: 'text' }
  | { readonly kind: 'number' }
  | { readonly kind: 'toggle' }
  | { readonly kind: 'choice'; readonly options: readonly string[] }

export interface FacetFormField {
  readonly name: string
  /** Human-facing; the field name until a definition can carry a label. */
  readonly label: string
  readonly control: FacetFormControl
  readonly required: boolean
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

function fieldsOf(
  shape: Record<string, z.ZodTypeAny>,
  skip?: string,
): readonly FacetFormField[] | undefined {
  const fields: FacetFormField[] = []
  for (const [name, member] of Object.entries(shape)) {
    if (name === skip) continue
    const { inner, required } = unwrap(member)
    const control = controlOf(inner)
    if (control === undefined) return undefined
    fields.push({ name, label: name, control, required })
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

export function deriveFacetForm(schema: z.ZodTypeAny): FacetForm {
  if (schema instanceof z.ZodObject) {
    const fields = fieldsOf(schema.shape as Record<string, z.ZodTypeAny>)
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
      const fields = fieldsOf(shape, name)
      if (fields === undefined) return UNSUPPORTED
      variants.push({ label, fields })
    }
    return discriminant === undefined ? UNSUPPORTED : { kind: 'variants', discriminant, variants }
  }
  return UNSUPPORTED
}
