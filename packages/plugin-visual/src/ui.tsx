/**
 * The `visual` plugin's React half, beside its data half in the same package.
 *
 * The split is within the plugin, not between the plugin and the core: the
 * data half must run on Node, in a worker and in the browser and therefore
 * cannot hold React, so it lives behind this package's default entry point
 * and this one behind `/ui`. What the core supplies is a library
 * (`facet-ui`), not the components.
 */
import { definePluginUi, type FacetEditor } from '@kamiazya/whiteboard-facet-ui'
import { Ban } from 'lucide-react'
import { createElement, type ReactNode } from 'react'
import { type VisualSymbolFacet, visualSymbolFacetSchema } from './data.js'
import type { LucideIconElement } from './icons/icons.js'
import { BUILT_IN_ICON_NAMES, LUCIDE_ICONS, LUCIDE_VIEWBOX } from './icons/icons.js'

/**
 * The symbol picker. Icons come from this plugin's own vendored set — the same
 * table `visual.symbol`'s schema enumerates and the renderer draws from, so
 * the row can never offer a name the canvas would silently drop; the emoji arm
 * carries a small starter set — a free-entry field is the editor-spec tier's
 * job, not a quick band's.
 */
const EMOJI_CHOICES = ['✅', '⚠️', '🔥', '⭐', '📌'] as const

const symbolEditor: FacetEditor = ({ value, write }) => {
  const current = visualSymbolFacetSchema.safeParse(value)
  const selected = current.success ? current.data : undefined
  const option = (
    key: string,
    label: string,
    content: ReactNode,
    on: boolean,
    payload: VisualSymbolFacet | undefined,
  ) => (
    // Real radios rather than buttons wearing the role: the roving-focus
    // and arrow-key behaviour a segmented control needs comes free with the
    // element, and the same choice was made for the declared controls.
    // Styled with values and the host's own theme CUSTOM PROPERTIES, not
    // with utility class names. Measured: a class name inside a workspace
    // package is never generated — tailwind's content detection stops at
    // the app — and a `@source` line per vessel is an opt-in step that gets
    // missed. A package that carries its own styles renders the same
    // wherever it is mounted.
    <label
      key={key}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '1.75rem',
        minWidth: '1.75rem',
        padding: '0 0.25rem',
        borderRadius: '0.25rem',
        fontSize: '0.75rem',
        cursor: 'pointer',
        background: on ? 'var(--accent, #f2f2f2)' : 'transparent',
        color: on ? 'var(--foreground, #171717)' : 'var(--muted-foreground, #737373)',
      }}
    >
      <input
        type="radio"
        name="visual-symbol"
        aria-label={label}
        checked={on}
        onChange={() => write(payload)}
        style={{
          position: 'absolute',
          width: 1,
          height: 1,
          overflow: 'hidden',
          clip: 'rect(0 0 0 0)',
          whiteSpace: 'nowrap',
        }}
      />
      <span aria-hidden="true" style={{ display: 'inline-flex', width: '1rem', height: '1rem' }}>
        {content}
      </span>
    </label>
  )
  return (
    <span
      role="radiogroup"
      aria-label="Symbol"
      style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.125rem' }}
    >
      {option('none', 'No symbol', <Ban />, selected === undefined, undefined)}
      {BUILT_IN_ICON_NAMES.map((name) =>
        option(
          name,
          `Icon ${name}`,
          <BuiltInIcon name={name} />,
          selected?.kind === 'icon' && selected.name === name,
          { kind: 'icon', name },
        ),
      )}
      {EMOJI_CHOICES.map((char) =>
        option(char, `Emoji ${char}`, char, selected?.kind === 'emoji' && selected.char === char, {
          kind: 'emoji',
          char,
        }),
      )}
    </span>
  )
}

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
  if (symbol.kind === 'emoji') return symbol.char
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
    { title: 'Symbol', facet: 'symbol', component: symbolEditor },
    { title: 'Text placement', facet: 'text' },
  ],
})
