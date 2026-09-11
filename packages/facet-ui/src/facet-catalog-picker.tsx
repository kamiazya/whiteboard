/**
 * The facet system's adapter onto `CatalogPicker`: it loads the catalog a
 * facet declares, and routes free entry through the write path.
 *
 * Thin on purpose. The picker underneath knows nothing about facets, so
 * this is the whole of what a facet adds — which is the honest measure of
 * how generic the control actually became.
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
      // free entry — and it is the same one `wb_facet_set` crosses.
      validateEntry={(payload) => registry.validateFacetWrite(facetKey, payload)}
      onPick={(option) => onPick(option.payload)}
    />
  )
}
