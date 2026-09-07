/**
 * Valid payloads for a facet, derived from the facet's own declaration.
 *
 * A property test that wants to exercise "a node carrying facets" has two
 * ways to get them: name each facet's payloads in the test, or ask the
 * registry. Only the second one covers a facet added later — which is the
 * whole reason this exists, because the failure mode it guards is a
 * consumer that resolves a facet on one code path and forgets it on
 * another, and a hand-listed generator cannot see the facet that was not
 * written yet.
 *
 * The vocabulary is `deriveFacetForm`'s, not a second reading of zod: a
 * schema the form layer cannot express answers `unsupported` there and an
 * empty list here, which a caller's own completeness check turns into a
 * failure naming the facet. Every candidate is parsed through the facet's
 * schema before it is returned, so a widened schema cannot leave a stale
 * sample silently generating payloads the reader drops.
 */

import type { z } from 'zod'
import { deriveFacetForm, type FacetFormControl, type FacetFormField } from './form.js'
import type { FacetDefinition } from './registry.js'

/**
 * How many payloads one facet may contribute. A facet with several
 * multi-valued fields has a combinatorial product behind it, and a
 * generator that draws from a list does not need the whole product — it
 * needs enough of it that every field's values are all reachable, which
 * the round-robin below gives at a fraction of the size.
 */
const MAX_SAMPLES_PER_FACET = 12

/** `undefined` means "leave this field out", which only an optional field may draw. */
type FieldValue = string | number | boolean | undefined

/**
 * Values worth trying for a free-text field. `'A'` and `'✅'` are single
 * grapheme clusters and `'sample'` is not — a schema that constrains text
 * to one grapheme (a badge) and one that only asks for non-empty are both
 * satisfied by this list rather than by a refinement-aware generator.
 */
const TEXT_VALUES: readonly string[] = ['A', '✅', 'sample']
const NUMBER_VALUES: readonly number[] = [0, 1, 42]
const BOOLEAN_VALUES: readonly boolean[] = [true, false]

function valuesOf(control: FacetFormControl): readonly FieldValue[] {
  switch (control.kind) {
    case 'text':
      return TEXT_VALUES
    case 'number':
      return NUMBER_VALUES
    case 'toggle':
      return BOOLEAN_VALUES
    case 'choice':
      return control.options
    case 'segmented':
      // A `null` segment CLEARS the facet, so it is the absence of a
      // payload rather than one of these.
      return control.options.flatMap((option) => (option.value === null ? [] : [option.value]))
  }
}

/**
 * One object per row of a round-robin over the fields' value lists: row `i`
 * takes each field's `i`th value, wrapping. Every value of every field is
 * therefore reachable in `max(len)` rows instead of the product's
 * `prod(len)`, and the fields still vary against each other.
 */
function combine(fields: readonly FacetFormField[]): readonly Record<string, unknown>[] {
  const columns = fields.map((field) => {
    const values = valuesOf(field.control)
    // An optional field must be drawable as absent, or a schema whose
    // fields are all optional never produces the empty payload it accepts.
    return { name: field.name, values: field.required ? values : [...values, undefined] }
  })
  if (columns.some((column) => column.values.length === 0)) return []
  const rows = Math.min(
    columns.reduce((widest, column) => Math.max(widest, column.values.length), 1),
    MAX_SAMPLES_PER_FACET,
  )
  const out: Record<string, unknown>[] = []
  for (let row = 0; row < rows; row++) {
    const payload: Record<string, unknown> = {}
    for (const column of columns) {
      const value = column.values[row % column.values.length]
      if (value !== undefined) payload[column.name] = value
    }
    out.push(payload)
  }
  return out
}

/**
 * Payloads this build can write for `definition`, each already accepted by
 * its schema. Empty means the facet's schema is outside the form layer's
 * vocabulary — the honest signal that a generator over this facet needs a
 * hand-written sample, in the same way `deriveFacetForm` reports a facet
 * that needs a hand-written widget.
 */
export function facetPayloadSamples(definition: FacetDefinition): readonly unknown[] {
  const form = deriveFacetForm(definition.schema, definition.editor)
  const candidates =
    form.kind === 'fields'
      ? combine(form.fields)
      : form.kind === 'variants'
        ? form.variants.flatMap((variant) =>
            combine(variant.fields).map((payload) => ({
              [form.discriminant]: variant.label,
              ...payload,
            })),
          )
        : []
  const schema = definition.schema as z.ZodTypeAny
  return candidates.filter((candidate) => schema.safeParse(candidate).success)
}
