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
import { type FacetRegistry, resolveFacetContributions } from '@kamiazya/whiteboard-facet-engine'
import type { FacetEditor, PluginUi } from '@kamiazya/whiteboard-facet-ui'
import type { EdgeRoutingStyle, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { resolveCanvasEdgeStyle } from '@kamiazya/whiteboard-plugin-visual'
import { visualUi } from '@kamiazya/whiteboard-plugin-visual/ui'
import { SlidersHorizontal } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import type { ContextMenuItem } from '../ContextMenu.js'
import type { EditorCommand } from '../commands.js'

/** `contextMenu.node.properties`: what a node quick-band widget receives. */
export interface NodePropertiesContext {
  /**
   * Opens the facet inspector for this node. The core surface owns the
   * inspector's mounting; the DOORWAY belongs here, so no point-owning
   * surface has to name the facet concept to offer one.
   */
  readonly openPanel: () => void
}

/** `canvasSettings`: what a canvas-settings panel widget receives. */
export interface CanvasSettingsContext {
  readonly canvas: SpatialCanvas
  readonly run: (command: EditorCommand) => void
}

export type CanvasSettingsWidget = (ctx: CanvasSettingsContext) => ReactNode

// --- visual.shape/v0 -------------------------------------------------------

// --- visual.symbol/v0 ------------------------------------------------------

/**
 * The plugin UI halves this composition root loads. A plugin's data half is
 * registered in the facet registry; this is the matching list for the half
 * that draws — joined by plugin id, so neither half imports the other.
 */
const PLUGIN_UIS: readonly PluginUi[] = [visualUi]

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
 * The `contextMenu.node.properties` point resolved to menu items: a
 * separator fencing the region off from the core rows, then one band group
 * per contributing namespace under the plugin's displayName, then the
 * doorway to the full panel. Group order is namespace-id lexicographic —
 * display wording never moves it.
 *
 * The heading is unconditional. An earlier rule dropped it while only one
 * namespace contributed, on the reasoning that a lone heading says nothing
 * — but what it actually says is WHERE THE CORE MENU ENDS, and without it
 * a facet row is indistinguishable from Color or Order. Reported from a
 * phone once a third band landed.
 */
/**
 * The node context menu's entire facet surface: one doorway, and nothing
 * that edits a facet.
 *
 * Quick bands used to live here. An action menu's entries run once and
 * close it; a facet is state you look at and adjust several times in a row,
 * so it belongs on the inspector — and the menu was growing a row per
 * domain, with a stored value one tap from Delete.
 *
 * No doorway at all when nothing targets a node: an inspector with nothing
 * in it is a dead end, not an empty state.
 */
export function nodePropertyItems(
  registry: FacetRegistry,
  ctx: NodePropertiesContext,
): readonly ContextMenuItem[] {
  if (resolveFacetContributions(registry, 'inspector.node').length === 0) return []
  return [
    { kind: 'separator' as const },
    { label: 'Facets…', icon: <SlidersHorizontal />, onSelect: ctx.openPanel },
  ]
}

// --- registrations ---------------------------------------------------------

/**
 * Tier-3 editors by facet key, resolved from what each PLUGIN declares.
 * This vessel registers none of its own: a facet's editor is the plugin's
 * to own, which is what stops the same facet from having one face here and
 * a different one on the next surface.
 */
export const NODE_FACET_EDITORS: Readonly<Record<string, FacetEditor>> = Object.fromEntries(
  PLUGIN_UIS.flatMap((ui) =>
    ui.sections.flatMap((section) =>
      section.component === undefined
        ? []
        : [[`${ui.plugin}.${section.facet}/v0`, section.component] as const],
    ),
  ),
)

export const CANVAS_SETTINGS_WIDGETS: Readonly<Record<string, CanvasSettingsWidget>> = {
  'visual.edges/v0': visualEdgesPanel,
}
