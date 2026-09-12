/**
 * The `visual` plugin's React half, beside its data half in the same package.
 *
 * The split is within the plugin, not between the plugin and the core: the
 * data half must run on Node, in a worker and in the browser and therefore
 * cannot hold React, so it lives behind this package's default entry point
 * and this one behind `/ui`. What the core supplies is a library
 * (`facet-ui`), not the components.
 */
import { definePluginUi, EmojiText } from '@kamiazya/whiteboard-facet-ui'
import { createElement, type ReactNode } from 'react'
import type { VisualSymbolFacet } from './data.js'
import type { LucideIconElement } from './icons/icons.js'
import { LUCIDE_ICONS, LUCIDE_VIEWBOX } from './icons/icons.js'

/**
 * Draws a vendored icon by name, from the SAME geometry the canvas renders,
 * so the picker cannot drift from the mark the other surfaces draw.
 */
function BuiltInIcon({ name }: { readonly name: string }) {
  return (
    <svg
      viewBox={LUCIDE_VIEWBOX}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {(LUCIDE_ICONS[name] ?? []).map((element, index) => {
        const { tag, ...attrs } = element
        // The vendored geometry is a fixed, never-reordered list, so the
        // index is a stable identity here.
        return createElement(tag, { ...attrs, key: `${tag}-${index}` })
      })}
    </svg>
  )
}

/**
 * A resolved symbol as DOM, for the surfaces that draw one outside a canvas
 * — the picker's own rows, a file row, a document's settings.
 *
 * It lives here so every such surface draws from the geometry the RENDERER
 * draws from: two producers of "what this symbol looks like" is how a row
 * comes to show a mark the canvas does not.
 *
 * Answers null for an icon name this build does not carry, which is the one
 * degradation every surface shares — the schema validates a name for
 * non-emptiness only, so an unknown one reaches here from any document
 * written elsewhere. What to show INSTEAD differs per surface (a file row
 * has its kind icon, the favicon has the document's outline), so the
 * decision stays with the caller and this only reports that it drew
 * nothing.
 */
export function SymbolMark({ symbol }: { readonly symbol: VisualSymbolFacet }): ReactNode {
  // Through `EmojiText`, because a bare character is drawn by whichever
  // installed font claims its codepoint first and several ordinary text
  // faces claim the common emoji as monochrome outlines. The minimap and
  // the picker are then the same mark rather than two.
  if (symbol.kind === 'emoji') return <EmojiText value={symbol.char} />
  return geometryOf(symbol) === undefined ? null : <BuiltInIcon name={symbol.name} />
}

/**
 * Whether `SymbolMark` will draw anything.
 *
 * A caller cannot ask the element: `<SymbolMark …/>` is a truthy value even
 * when the component renders null, so a surface that chooses its fallback
 * by testing the element renders an empty box for every unknown name. Both
 * of these read `geometryOf`, so the answer and the drawing cannot drift.
 */
export function canDrawSymbol(symbol: VisualSymbolFacet): boolean {
  return symbol.kind === 'emoji' || geometryOf(symbol) !== undefined
}

function geometryOf(symbol: VisualSymbolFacet): ReadonlyArray<LucideIconElement> | undefined {
  return symbol.kind === 'icon' ? LUCIDE_ICONS[symbol.name] : undefined
}

export const visualUi = definePluginUi({
  plugin: 'visual',
  sections: [
    // Order is the plugin's, and it is not the registry's alphabetical one:
    // shape is what a person reaches for most, and the symbol belongs beside
    // it rather than after the text setting.
    { title: 'Shape', facet: 'shape' },
    // No `component`. Symbol had one — the only tier-3 editor this
    // codebase ever shipped — because its twelve choices straddle two
    // schema arms and a field-level control could not express them. The
    // facet-level picker can, so the declaration in `data.ts` is the whole
    // UI now and every vessel draws it the same way. `component` stays a
    // real point with no bundled user, deliberately, the way
    // `RenderContribution.decorations` does: it is the contract with every
    // plugin, not a convenience for this one.
    { title: 'Symbol', facet: 'symbol' },
    { title: 'Text placement', facet: 'text' },
  ],
})
