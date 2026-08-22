/**
 * The EXTENSION side of the facet-UI seam: quick-edit widgets keyed by facet
 * key, one registration per contribution point. This module is the ONE place
 * on the web side allowed to name a facet domain — the point-owning surfaces
 * (CanvasContextMenu, CanvasDisplaySettings) iterate contribution groups and
 * look widgets up here, and `facet-wiring-guard.test.ts` keeps them that way.
 *
 * A facet with no widget registered simply contributes nothing yet — the
 * later editor-spec tier derives a default form instead of failing here.
 */
import {
  BUILT_IN_ICON_NAMES,
  LUCIDE_ICONS,
  LUCIDE_VIEWBOX,
} from '@kamiazya/whiteboard-canvas-render'
import {
  deriveFacetForm,
  type FacetDefinition,
  type FacetGlyph,
  type FacetRegistry,
  resolveCanvasEdgeStyle,
  resolveFacetContributions,
  resolveNodeSymbol,
  VISUAL_SYMBOL_KEY,
  type VisualSymbolFacet,
} from '@kamiazya/whiteboard-facet-engine'
import type { EdgeRoutingStyle, SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import { Ban, Circle, Cylinder, Diamond, Hexagon, Square } from 'lucide-react'
import { createElement, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import type { ContextMenuItem } from '../ContextMenu.js'
import type { EditorCommand } from '../commands.js'

/** `contextMenu.node.properties`: what a node quick-band widget receives. */
export interface NodePropertiesContext {
  readonly node: SpatialNode
  /** Applies per-target commands with the menu's selection semantics. */
  readonly applyToSelection: (
    commandsFor: (targetIds: readonly string[]) => readonly EditorCommand[],
  ) => void
}

export type NodePropertiesWidget = (ctx: NodePropertiesContext) => readonly ContextMenuItem[]

/** `canvasSettings`: what a canvas-settings panel widget receives. */
export interface CanvasSettingsContext {
  readonly canvas: SpatialCanvas
  readonly run: (command: EditorCommand) => void
}

export type CanvasSettingsWidget = (ctx: CanvasSettingsContext) => ReactNode

// --- visual.shape/v0 -------------------------------------------------------

/**
 * The core's glyph vocabulary rendered: a spec NAMES a glyph, this maps the
 * name to a drawing. Keeping the map here (not in the engine) is the same
 * split as everywhere else — the engine owns what may be said, the vessel
 * owns how it looks.
 */
function FacetGlyphIcon({ glyph }: { readonly glyph?: FacetGlyph }) {
  switch (glyph) {
    case 'square':
      return <Square />
    case 'circle':
      return <Circle />
    case 'diamond':
      return <Diamond />
    case 'hexagon':
      return <Hexagon />
    case 'parallelogram':
      // No lucide glyph for a parallelogram; drawn in the same 24-grid
      // stroke style so a row of these reads as one set.
      return (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M7 5h14l-4 14H3Z" />
        </svg>
      )
    case 'cylinder':
      return <Cylinder />
    default:
      return undefined
  }
}

// --- visual.symbol/v0 ------------------------------------------------------

/**
 * The badge picker. Icons come from the RENDERER's vendored set, so the row
 * can never offer a name the canvas would silently drop; the emoji arm
 * carries a small starter set — a free-entry field is the editor-spec tier's
 * job, not a quick band's.
 */
const EMOJI_CHOICES = ['✅', '⚠️', '🔥', '⭐', '📌'] as const

const visualSymbolBand: NodePropertiesWidget = ({ node, applyToSelection }) => {
  const current = resolveNodeSymbol(node)
  const applySymbol = (payload: VisualSymbolFacet | undefined) => {
    applyToSelection((ids) =>
      ids.map((id) => ({ kind: 'set-node-facet' as const, id, key: VISUAL_SYMBOL_KEY, payload })),
    )
  }
  return [
    {
      kind: 'options' as const,
      label: 'Symbol',
      options: [
        {
          label: 'none',
          ariaLabel: 'No symbol',
          icon: <Ban />,
          selected: current === undefined,
          onSelect: () => applySymbol(undefined),
        },
        ...BUILT_IN_ICON_NAMES.map((name) => ({
          label: name,
          ariaLabel: `Icon ${name}`,
          icon: <BuiltInIcon name={name} />,
          selected: current?.kind === 'icon' && current.name === name,
          onSelect: () => applySymbol({ kind: 'icon', name }),
        })),
        ...EMOJI_CHOICES.map((char) => ({
          label: char,
          ariaLabel: `Emoji ${char}`,
          selected: current?.kind === 'emoji' && current.char === char,
          onSelect: () => applySymbol({ kind: 'emoji', char }),
        })),
      ],
    },
  ]
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

// --- visual.edges/v0 -------------------------------------------------------

const EDGE_ROUTING_CHOICES: readonly { style: EdgeRoutingStyle; label: string }[] = [
  { style: 'straight', label: 'Straight' },
  { style: 'orthogonal', label: 'Orthogonal' },
  { style: 'curved', label: 'Curved' },
]

const OPTION_CLASS =
  'flex h-7 min-w-7 items-center justify-center rounded px-2 text-xs transition-colors duration-(--motion-duration-fast) ease-(--motion-ease-out) hover:bg-accent focus-visible:bg-accent focus-visible:outline-none'

const visualEdgesPanel: CanvasSettingsWidget = ({ canvas, run }) => {
  // Facet-first (visual.edges/v0), legacy edgeRouting fallback — the same
  // resolution the renderer defaults to, so the checked segment always
  // matches what the canvas draws.
  const current = resolveCanvasEdgeStyle(canvas)
  const currentRouting = current.style ?? 'straight'
  const currentJumps = current.lineJumps ?? 'none'
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-muted-foreground">Edge routing</span>
        <span className="flex items-center gap-0.5">
          {EDGE_ROUTING_CHOICES.map(({ style, label }) => (
            <button
              key={style}
              type="button"
              aria-pressed={currentRouting === style}
              onClick={() => run({ kind: 'set-edge-routing', style })}
              className={cn(
                OPTION_CLASS,
                currentRouting === style
                  ? 'bg-accent font-medium text-foreground'
                  : 'text-muted-foreground',
              )}
            >
              {label}
            </button>
          ))}
        </span>
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-muted-foreground">Line jumps</span>
        <span className="flex items-center gap-0.5">
          {(
            [
              { lineJumps: 'none', label: 'Off' },
              { lineJumps: 'arc', label: 'On' },
            ] as const
          ).map(({ lineJumps, label }) => (
            <button
              key={lineJumps}
              type="button"
              aria-pressed={currentJumps === lineJumps}
              onClick={() => run({ kind: 'set-line-jumps', lineJumps })}
              className={cn(
                OPTION_CLASS,
                currentJumps === lineJumps
                  ? 'bg-accent font-medium text-foreground'
                  : 'text-muted-foreground',
              )}
            >
              {label}
            </button>
          ))}
        </span>
      </div>
    </div>
  )
}

/**
 * The `contextMenu.node.properties` point resolved to menu items: bands per
 * contributing namespace, headed by the plugin's displayName only once a
 * SECOND namespace contributes (one namespace stays unlabeled). Group order
 * is namespace-id lexicographic — display wording never moves it.
 */
/**
 * Tier 2: a facet that DECLARES its editor gets its quick band rendered
 * from the declaration — no per-facet React. The glyph vocabulary is the
 * core's (a plugin names one, it cannot ship one), which is what keeps a
 * declared editor a declaration rather than third-party UI code.
 */
function declaredBands(
  facetKey: string,
  definition: FacetDefinition,
  ctx: NodePropertiesContext,
): readonly ContextMenuItem[] {
  if (definition.editor === undefined) return []
  const form = deriveFacetForm(definition.schema, definition.editor)
  if (form.kind !== 'fields') return []
  const stored = ctx.node['x-whiteboard']?.facets?.[facetKey] as Record<string, unknown> | undefined
  return form.fields.flatMap((field) => {
    if (!field.quick || field.control.kind !== 'segmented') return []
    const current = stored?.[field.name]
    return [
      {
        kind: 'options' as const,
        label: field.label,
        options: field.control.options.map((option) => ({
          label: option.value ?? 'none',
          ariaLabel: option.label,
          icon: <FacetGlyphIcon glyph={option.glyph} />,
          // A null option means the facet's ABSENCE, which is why the
          // comparison is against undefined rather than the value.
          selected: option.value === null ? stored === undefined : current === option.value,
          onSelect: () => {
            ctx.applyToSelection((ids) =>
              ids.map((id) => ({
                kind: 'set-node-facet' as const,
                id,
                key: facetKey,
                payload: option.value === null ? undefined : { [field.name]: option.value },
              })),
            )
          },
        })),
      },
    ]
  })
}

export function nodePropertyItems(
  registry: FacetRegistry,
  ctx: NodePropertiesContext,
  widgets: Readonly<Record<string, NodePropertiesWidget>> = NODE_PROPERTIES_WIDGETS,
): readonly ContextMenuItem[] {
  const contributed = resolveFacetContributions(registry, 'contextMenu.node.properties')
    .map((group) => ({
      group,
      // A hand-written widget still wins where one is registered (tier 2
      // is a ladder, not a replacement): a picker the catalog cannot yet
      // express keeps its code.
      bands: group.facets.flatMap(
        (facet) => widgets[facet.key]?.(ctx) ?? declaredBands(facet.key, facet.definition, ctx),
      ),
    }))
    .filter((entry) => entry.bands.length > 0)
  return contributed.flatMap(({ group, bands }) =>
    contributed.length >= 2
      ? [{ kind: 'heading' as const, label: group.displayName }, ...bands]
      : bands,
  )
}

// --- registrations ---------------------------------------------------------

export const NODE_PROPERTIES_WIDGETS: Readonly<Record<string, NodePropertiesWidget>> = {
  // visual.shape is NOT here: it declares its band (see visual.ts's editor
  // spec) and is rendered from that declaration — the acceptance test for
  // tier 2 being usable by the plugin that ships with the engine.
  'visual.symbol/v0': visualSymbolBand,
}

export const CANVAS_SETTINGS_WIDGETS: Readonly<Record<string, CanvasSettingsWidget>> = {
  'visual.edges/v0': visualEdgesPanel,
}
