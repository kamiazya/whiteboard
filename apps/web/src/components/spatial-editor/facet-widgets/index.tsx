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
  type FacetRegistry,
  resolveCanvasEdgeStyle,
  resolveFacetContributions,
  resolveNodeShape,
  type VisualShapeFacet,
} from '@kamiazya/whiteboard-facet-engine'
import type { EdgeRoutingStyle, SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import { Circle, Cylinder, Diamond, Hexagon, Square } from 'lucide-react'
import type { ReactNode } from 'react'
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

const visualShapeBand: NodePropertiesWidget = ({ node, applyToSelection }) => {
  const currentShape = resolveNodeShape(node)
  const applyShape = (shape: VisualShapeFacet['kind'] | undefined) => {
    applyToSelection((ids) => ids.map((id) => ({ kind: 'set-node-shape' as const, id, shape })))
  }
  const shapeOption = (shape: VisualShapeFacet['kind'], ariaLabel: string, icon: ReactNode) => ({
    label: shape,
    ariaLabel,
    icon,
    selected: currentShape === shape,
    onSelect: () => applyShape(shape),
  })
  return [
    {
      kind: 'options' as const,
      label: 'Shape',
      options: [
        // `rect` is the historic default and deliberately unrepresentable
        // as a value — choosing it removes the facet.
        {
          label: 'rect',
          ariaLabel: 'Rectangle',
          icon: <Square />,
          selected: currentShape === undefined,
          onSelect: () => applyShape(undefined),
        },
        shapeOption('ellipse', 'Ellipse', <Circle />),
        shapeOption('diamond', 'Diamond', <Diamond />),
        shapeOption('hexagon', 'Hexagon', <Hexagon />),
        shapeOption(
          'parallelogram',
          'Parallelogram',
          // No lucide glyph for a parallelogram; drawn in the same 24-grid
          // stroke style so the row reads as one set.
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M7 5h14l-4 14H3Z" />
          </svg>,
        ),
        shapeOption('cylinder', 'Cylinder', <Cylinder />),
      ],
    },
  ]
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
export function nodePropertyItems(
  registry: FacetRegistry,
  ctx: NodePropertiesContext,
  widgets: Readonly<Record<string, NodePropertiesWidget>> = NODE_PROPERTIES_WIDGETS,
): readonly ContextMenuItem[] {
  const contributed = resolveFacetContributions(registry, 'contextMenu.node.properties')
    .map((group) => ({
      group,
      bands: group.facets.flatMap((facet) => widgets[facet.key]?.(ctx) ?? []),
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
  'visual.shape/v0': visualShapeBand,
}

export const CANVAS_SETTINGS_WIDGETS: Readonly<Record<string, CanvasSettingsWidget>> = {
  'visual.edges/v0': visualEdgesPanel,
}
