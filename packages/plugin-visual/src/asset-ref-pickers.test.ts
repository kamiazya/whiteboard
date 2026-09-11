// A shipped facet whose value must name a REGISTERED asset needs a PICKER,
// and this is the executable form of a defect that shipped.
//
// `visual.stencil/v0` validates its value against the registered stencil
// ids, and the derived form gave it a text box with a Save button, because
// the schema is a regex-checked string. The one id a person could type by
// hand was a wrong one. `facet-panel.browser.test.tsx` caught it only
// indirectly — by asserting that no Save button exists on that panel — which
// names neither the facet nor the cause, and would stop covering it the
// moment some other facet legitimately wanted free entry.
//
// Held HERE rather than thrown by `defineFacet`, deliberately. Measured: the
// engine-level throw failed four test fixtures that declare `assetRefs` and
// have no UI at all, which is a legitimate thing for a test double to be.
// Forcing each to declare a widget is how a check gets satisfied
// mechanically instead of read. The rule is about what this repo SHIPS, so
// it is scoped to what this repo ships.
import { facetPayloadKey } from '@kamiazya/whiteboard-facet-engine'
import { describe, expect, it } from 'vitest'
import { bundledFacetRegistry, bundledPlugins } from './data.js'

describe('a shipped facet that names an asset offers a picker', () => {
  it('offers a picked value, never free entry, for every assetRefs field', () => {
    const freeEntry = bundledPlugins.flatMap((plugin) =>
      plugin.facets.flatMap((facet) =>
        Object.keys(facet.assetRefs ?? {})
          .filter((field) => {
            // A facet-level PICKER satisfies this outright, and does so more
            // strongly than a per-field widget: it writes whole payloads
            // drawn from a declared list, and `assertPickerFits` parses
            // every one against the facet's own schema at `defineFacet`
            // time. There is no field to type into at all. `visual.theme`
            // takes that form; `visual.stencil` takes the per-field one.
            if (facet.editor?.picker !== undefined) return false
            const widget = facet.editor?.fields?.[field]?.widget
            return widget !== 'segmented' && widget !== 'choice'
          })
          .map((field) => `${plugin.id}.${facet.name}/${facet.version} field "${field}"`),
      ),
    )
    expect(freeEntry).toEqual([])
  })

  /**
   * One level in from the rule above, and the gap it leaves.
   *
   * `assertPickerFits` parses each option against the facet's SCHEMA, which
   * for an asset ref is `namespacedIdSchema` — a shape check that knows
   * nothing about what is registered. So an option naming a theme no plugin
   * registers is declared happily, ships, and is refused only at
   * `validateFacetWrite`: the option draws, a person presses it, and
   * nothing happens. That is the same defect the rule above exists to stop,
   * one layer down, and the registry is the only place that can see it.
   */
  it('every picker option names an asset this build actually registers', () => {
    const unregistered = bundledPlugins.flatMap((plugin) =>
      plugin.facets.flatMap((facet) =>
        (facet.editor?.picker?.options ?? []).flatMap((option) =>
          Object.entries(facet.assetRefs ?? {}).flatMap(([field, kind]) => {
            const id = (option.payload as Record<string, unknown> | null)?.[field]
            if (typeof id !== 'string') return []
            return bundledFacetRegistry.assetIds(kind).includes(id)
              ? []
              : [`${plugin.id}.${facet.name}/${facet.version} "${option.label}" -> ${id}`]
          }),
        ),
      ),
    )
    expect(unregistered).toEqual([])
  })

  it('finds the picker options it is judging, so an empty pass is not a broken scan', () => {
    // The companion to the field count below: a picker whose options stopped
    // being read would report zero unregistered ids forever.
    const judged = bundledPlugins.flatMap((plugin) =>
      plugin.facets.flatMap((facet) =>
        (facet.editor?.picker?.options ?? [])
          .filter((option) =>
            Object.keys(facet.assetRefs ?? {}).some(
              (field) => (option.payload as Record<string, unknown> | null)?.[field] !== undefined,
            ),
          )
          .map((option) => facetPayloadKey(option.payload)),
      ),
    )
    expect(judged).toEqual(['{"theme":"visual.sketch"}', '{"theme":"visual.neon"}'])
  })

  it('finds the fields it is judging, so an empty pass is not a broken scan', () => {
    // Without this, a rename of `assetRefs` turns the assertion above into
    // "nothing to check" and it passes forever over a surface it cannot see.
    const judged = bundledPlugins.flatMap((plugin) =>
      plugin.facets.flatMap((facet) => Object.keys(facet.assetRefs ?? {})),
    )
    expect(judged.sort()).toEqual(['stencil', 'theme'])
  })
})
