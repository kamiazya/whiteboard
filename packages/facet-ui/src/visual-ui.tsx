/**
 * The bundled `visual` plugin's UI half.
 *
 * Its data half — schemas, resolvers, migrations — lives in `facet-engine`,
 * which must run on Node, in a worker and in the browser and therefore
 * cannot hold React. The split is the plugin's, not a privilege of being
 * bundled: a third-party plugin is shaped the same way, with its data half
 * wherever `canvas-render` can reach it and its UI half here.
 */
import {
  BUILT_IN_ICON_NAMES,
  LUCIDE_ICONS,
  LUCIDE_VIEWBOX,
} from '@kamiazya/whiteboard-canvas-render'
import { type VisualSymbolFacet, visualSymbolFacetSchema } from '@kamiazya/whiteboard-facet-engine'
import { Ban } from 'lucide-react'
import { createElement, type ReactNode } from 'react'
import { definePluginUi, type FacetEditor } from './plugin-ui.js'

/**
 * The badge picker. Icons come from the RENDERER's vendored set, so the row
 * can never offer a name the canvas would silently drop; the emoji arm
 * carries a small starter set — a free-entry field is the editor-spec tier's
 * job, not a quick band's.
 */
const EMOJI_CHOICES = ['✅', '⚠️', '🔥', '⭐', '📌'] as const

const badgeEditor: FacetEditor = ({ value, write }) => {
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
 * so the picker cannot drift from the badge it produces.
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

export const visualUi = definePluginUi({
  plugin: 'visual',
  sections: [
    // Order is the plugin's, and it is not the registry's alphabetical one:
    // shape is what a person reaches for most, and the badge belongs beside
    // it rather than after the text setting.
    { title: 'Shape', facet: 'shape' },
    { title: 'Badge', facet: 'symbol', component: badgeEditor },
    { title: 'Text placement', facet: 'text' },
  ],
})
