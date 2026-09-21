/**
 * What the rest of the board already wrote into a facet's text fields, so
 * the derived form can offer it: after the first box is classified by hand
 * (`health` / `failing`), the second is a pick rather than a spelling.
 *
 * Generic over every fields-form facet rather than knowing the
 * classification one: the panel derives its forms from the registry, and a
 * facet added tomorrow should get the same help with no vessel edit — the
 * same bargain `visual.text` proved for the context menu.
 */
import type { FacetRegistry } from '@kamiazya/whiteboard-facet-engine'
import type { SpatialNode } from '@kamiazya/whiteboard-model'

export type FieldSuggestions = Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>

/**
 * One facet payload's contribution to the running set.
 *
 * A key whose form has no text fields, or a payload that is not an object,
 * contributes nothing — the suggestions are values a person TYPED, so only a
 * declared text field can hold one, and an empty string is not a suggestion.
 */
function collectFrom(
  seen: Map<string, Map<string, Set<string>>>,
  key: string,
  payload: unknown,
  fields: readonly string[] | undefined,
): void {
  if (fields === undefined || typeof payload !== 'object' || payload === null) return
  const byField = seen.get(key) ?? new Map<string, Set<string>>()
  for (const name of fields) {
    const value = (payload as Record<string, unknown>)[name]
    if (typeof value !== 'string' || value === '') continue
    const values = byField.get(name) ?? new Set<string>()
    values.add(value)
    byField.set(name, values)
  }
  if (byField.size > 0) seen.set(key, byField)
}

export function collectFieldSuggestions(
  nodes: readonly SpatialNode[],
  registry: FacetRegistry,
): FieldSuggestions {
  const seen = new Map<string, Map<string, Set<string>>>()
  const textFields = new Map<string, readonly string[] | undefined>()
  const textFieldsOf = (key: string): readonly string[] | undefined => {
    if (!textFields.has(key)) {
      const form = registry.facetForm(key)
      textFields.set(
        key,
        form.kind === 'fields'
          ? form.fields.filter((f) => f.control.kind === 'text').map((f) => f.name)
          : undefined,
      )
    }
    return textFields.get(key)
  }
  for (const node of nodes) {
    for (const [key, payload] of Object.entries(node.facets ?? {})) {
      collectFrom(seen, key, payload, textFieldsOf(key))
    }
  }
  // Sorted, so the list reads the same however the board was written —
  // and by LOCALE, because these are values a person typed and is about to
  // read back. A default sort orders by UTF-16 code unit, which puts every
  // Japanese value after every Latin one and scrambles kana among
  // themselves; this list is drawn in the Facets panel, so that is a
  // reading order nobody wants.
  const byName = (a: string, b: string) => a.localeCompare(b)
  return Object.fromEntries(
    [...seen].map(([key, byField]) => [
      key,
      Object.fromEntries([...byField].map(([name, values]) => [name, [...values].sort(byName)])),
    ]),
  )
}
