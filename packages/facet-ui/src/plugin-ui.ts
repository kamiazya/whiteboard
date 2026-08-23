/**
 * How a plugin says what its settings surface looks like.
 *
 * The engine answers WHICH facets a point carries, derived from their
 * targets. It cannot answer what to call the group they belong to, or what
 * order a person should meet them in — those are the plugin's judgement, and
 * before this they were the vessel's by default, which is how one facet came
 * to have two different editors on two different surfaces.
 *
 * A section names a facet and, only where the declared editor vocabulary
 * cannot reach it, a component. Reaching for the component is the exception:
 * a declared editor renders identically in every vessel, and a component
 * renders wherever someone remembered to mount it.
 */
import type { FacetRegistry } from '@kamiazya/whiteboard-facet-engine'
import type { ReactNode } from 'react'

/** What a plugin-supplied editor receives. `undefined` value = facet absent. */
export interface FacetEditorProps {
  readonly value: unknown
  /** Already validated: see `createFacetWriter`. `undefined` clears the facet. */
  readonly write: (payload: unknown) => void
}

export type FacetEditor = (props: FacetEditorProps) => ReactNode

export interface PluginUiSection {
  /** Heading a person reads. Not the facet's name — a plugin may group. */
  readonly title: string
  /** Facet NAME within this plugin, not the full versioned key. */
  readonly facet: string
  /** Tier 3. Absent means the facet's declared editor renders it. */
  readonly component?: FacetEditor
}

export interface PluginUi {
  /** The plugin id whose facets these sections address. */
  readonly plugin: string
  readonly sections: readonly PluginUiSection[]
}

export function definePluginUi(ui: PluginUi): PluginUi {
  const seen = new Set<string>()
  for (const section of ui.sections) {
    if (seen.has(section.facet)) {
      throw new Error(`plugin "${ui.plugin}" declares facet "${section.facet}" twice`)
    }
    seen.add(section.facet)
  }
  return ui
}

/**
 * The one path a facet editor's value takes to storage.
 *
 * This is the guarantee half of the bargain: a plugin draws whatever it
 * likes, and still cannot store what `wb_facet_set` would refuse. An invalid
 * payload is dropped rather than thrown — an editor mid-interaction is not
 * an error condition, and the control simply does not take the value.
 */
export function createFacetWriter(
  registry: FacetRegistry,
  key: string,
  onWrite: (key: string, payload: unknown) => void,
): (payload: unknown) => void {
  return (payload) => {
    // Clearing is not a payload, so there is nothing to validate.
    if (payload === undefined) return onWrite(key, undefined)
    const result = registry.validateFacetWrite(key, payload)
    if (result.ok) onWrite(key, result.value)
  }
}
