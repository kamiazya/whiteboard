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
import { describe, expect, it } from 'vitest'
import { bundledPlugins } from './data.js'

describe('a shipped facet that names an asset offers a picker', () => {
  it('declares a segmented or choice widget for every assetRefs field', () => {
    const freeEntry = bundledPlugins.flatMap((plugin) =>
      plugin.facets.flatMap((facet) =>
        Object.keys(facet.assetRefs ?? {})
          .filter((field) => {
            const widget = facet.editor?.fields[field]?.widget
            return widget !== 'segmented' && widget !== 'choice'
          })
          .map((field) => `${plugin.id}.${facet.name}/${facet.version} field "${field}"`),
      ),
    )
    expect(freeEntry).toEqual([])
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
