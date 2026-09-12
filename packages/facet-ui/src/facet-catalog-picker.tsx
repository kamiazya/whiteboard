/**
 * The facet system's adapter onto `CatalogPicker`: it loads the catalog a
 * facet declares, and is the boundary every value it offers crosses.
 *
 * Thin on purpose. The picker underneath knows nothing about facets, so
 * this is the whole of what a facet adds — which is the honest measure of
 * how generic the control actually became.
 *
 * Thin, but not a pass-through. Both directions a value can arrive from —
 * a row the loader produced and text a person typed — are parsed by the
 * facet's own schema here, because this is the last place that knows which
 * facet is being written: below it `CatalogPicker` holds no rule about
 * symbols, and above it the spatial editor's `set-node-facet` stores
 * whatever it is handed.
 */
import type {
  FacetPickerCatalogSection,
  FacetPickerCatalogSpec,
  FacetPickerOption,
  FacetRegistry,
} from '@kamiazya/whiteboard-facet-engine'
import { useEffect, useState } from 'react'
import { CatalogPicker } from './catalog-picker.js'

export interface FacetCatalogPickerProps {
  readonly facetKey: string
  /** The facet's own display name, so each band can say which facet it is in. */
  readonly title: string
  readonly catalog: FacetPickerCatalogSpec
  readonly registry: FacetRegistry
  /** The picker's inline options — this facet's short, fixed vocabulary. */
  readonly listed?: readonly FacetPickerOption[]
  readonly listedLayout?: 'chips' | 'cards'
  /** `facetPayloadKey` of what is stored, so a cell knows if it is the current one. */
  readonly selectedKey: string
  readonly onPick: (payload: unknown) => void
}

export function FacetCatalogPicker({
  facetKey,
  title,
  catalog,
  registry,
  listed,
  listedLayout,
  selectedKey,
  onPick,
}: FacetCatalogPickerProps) {
  const [sections, setSections] = useState<readonly FacetPickerCatalogSection[]>([])
  const [status, setStatus] = useState<'loading' | 'failed' | undefined>('loading')

  const load = catalog.load
  useEffect(() => {
    let live = true
    load().then(
      (loaded) => {
        if (!live) return
        setSections(loaded)
        setStatus(undefined)
      },
      () => {
        // A catalog that will not load leaves the listed options and free
        // entry working, so the picker degrades to what it was rather than
        // to nothing. Saying so beats an empty band a person waits at.
        if (live) setStatus('failed')
      },
    )
    return () => {
      live = false
    }
  }, [load])

  return (
    <CatalogPicker
      name={`facet-catalog-${facetKey}`}
      title={title}
      searchLabel={catalog.label}
      sections={sections}
      selectedKey={selectedKey}
      {...(listed === undefined ? {} : { listed })}
      {...(listedLayout === undefined ? {} : { listedLayout })}
      {...(catalog.entry === undefined ? {} : { entry: catalog.entry })}
      {...(status === undefined ? {} : { status })}
      registry={registry}
      // The facet's own schema decides, at the same boundary every other
      // write crosses. A catalog's rows were never parsed at definition
      // time (a loader is not loaded then), so this is the only net under
      // one — and it is the same one `wb_facet_set` crosses.
      validateEntry={(payload) => registry.validateFacetWrite(facetKey, payload)}
      onPick={(option) => {
        // Every LOADED row crosses it too, and this line is the whole of
        // that net: a listed option was parsed at `defineFacet` time, but a
        // catalog's rows arrive after the definition has already travelled
        // into the renderer, the layout worker and the MCP server. Without
        // this the picker was the one door into `set-node-facet` that let
        // an unparsed payload through — the mutators store what they are
        // handed — so a loader could write a shape the facet refuses.
        //
        // At the PICK rather than over the loaded sections, measured: the
        // bundled catalog is 1914 rows and validating all of them costs
        // 15-23ms of the thread that just opened the panel, every open. A
        // row the facet refuses is a plugin defect its own catalog test
        // owes (`plugin-visual/src/emoji/catalog.test.ts` parses all 1914);
        // paying a frame per open to soften it is the wrong trade. What
        // this must not do is let it reach storage, and it does not.
        //
        // `null` is the ABSENCE of the facet, so there is nothing to parse.
        if (option.payload === null) return onPick(null)
        const result = registry.validateFacetWrite(facetKey, option.payload)
        // The parsed value, not the row's own — the same thing
        // `createFacetWriter` stores, so a schema with a default or a
        // coercion cannot mean one shape here and another through the tool.
        if (result.ok) onPick(result.value)
      }}
    />
  )
}
