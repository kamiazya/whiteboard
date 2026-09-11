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
import type { FacetOptionLayout, FacetSegmentedOption } from '@kamiazya/whiteboard-facet-engine'
import {
  type ContributionPoint,
  type FacetRegistry,
  resolveFacetContributions,
} from '@kamiazya/whiteboard-facet-engine'
import {
  DerivedFacetForm,
  type FacetEditor,
  FacetOption,
  FacetOptionGroup,
  glyphIcon,
  type PluginUi,
} from '@kamiazya/whiteboard-facet-ui'
import type { EdgeRoutingStyle, LineJumps, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { resolveEffectiveCanvasEdgeStyle } from '@kamiazya/whiteboard-plugin-visual'
import { visualUi } from '@kamiazya/whiteboard-plugin-visual/ui'
import { SlidersHorizontal } from 'lucide-react'
import type { ReactNode } from 'react'
import type { EditorCommand } from '../../../lib/spatial/commands.js'
import type { ContextMenuItem } from '../ContextMenu.js'

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
  /**
   * The registry the panel resolved its rows from — what a derived row
   * builds its form from too, so a host passing its own registry never
   * gets a row selected by one definition and drawn by another.
   */
  readonly facetRegistry: FacetRegistry
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

/**
 * The one canvas row this vessel still draws itself, and the reason it does:
 * what the row must show is the EFFECTIVE value — the facet, else the
 * theme's default, else the built-in — which is a resolution only a surface
 * holding the canvas AND the registry can make. Under neon, nothing stored
 * means Orthogonal is pressed, not Straight.
 *
 * `DerivedFacetForm` cannot answer that. Its `stored` IS the payload, so
 * seeding it with a resolved value would make every control claim something
 * is written that is not, and its whole-draft write would then record both
 * axes on a pick that touched one. The commands here canonicalise instead:
 * picking the value the theme already has stores nothing, which is what
 * lets the row go back to following the theme.
 *
 * What it does NOT draw itself is the row's VOCABULARY. Labels, order and
 * glyphs come from the facet's own declared editor spec, read through the
 * registry — the same derivation every other row is drawn from, so this
 * surface names no routing style and cannot drift from the plugin.
 */
const EDGES_KEY = 'visual.edges/v0'

/** The declared segments for one field of the edges facet, or none. */
function edgeSegments(
  registry: FacetRegistry,
  field: string,
):
  | { label: string; options: readonly FacetSegmentedOption[]; layout: FacetOptionLayout }
  | undefined {
  const form = registry.facetForm(EDGES_KEY)
  if (form.kind !== 'fields') return undefined
  const found = form.fields.find((candidate) => candidate.name === field)
  if (found === undefined || found.control.kind !== 'segmented') return undefined
  return { label: found.label, options: found.control.options, layout: found.control.layout }
}

function EdgeSegmentRow({
  registry,
  field,
  current,
  onPick,
}: {
  readonly registry: FacetRegistry
  readonly field: string
  /** The EFFECTIVE value, so the pressed segment matches what is drawn. */
  readonly current: string | undefined
  readonly onPick: (value: string) => void
}) {
  const row = edgeSegments(registry, field)
  if (row === undefined) return null
  // A card grid takes the whole width, so its name sits above rather than
  // beside — the same arrangement `DerivedFacetForm` makes for the rows it
  // draws, so the panel reads as one panel.
  return (
    <div
      className={
        row.layout === 'cards' ? 'flex flex-col gap-1.5' : 'flex items-center justify-between gap-3'
      }
    >
      <span className="text-xs text-muted-foreground">{row.label}</span>
      <FacetOptionGroup label={row.label} layout={row.layout}>
        {row.options.map((option) => {
          // `value: null` would mean "clear the facet" — neither edges field
          // declares one, because absence here is reached by picking the
          // theme's own value and letting the command canonicalise.
          if (option.value === null) return null
          const glyph = glyphIcon(option.glyph, registry)
          const value = option.value
          return (
            <FacetOption
              key={value}
              name={`canvas-edges-${field}`}
              label={option.label}
              layout={row.layout}
              selected={current === value}
              onSelect={() => onPick(value)}
              {...(glyph === undefined ? {} : { glyph })}
            />
          )
        })}
      </FacetOptionGroup>
    </div>
  )
}

const visualEdgesPanel: CanvasSettingsWidget = ({ canvas, run, facetRegistry }) => {
  const current = resolveEffectiveCanvasEdgeStyle(canvas, facetRegistry)
  return (
    <div className="flex flex-col gap-1">
      <EdgeSegmentRow
        registry={facetRegistry}
        field="routing"
        current={current.style}
        onPick={(value) => run({ kind: 'set-edge-routing', style: value as EdgeRoutingStyle })}
      />
      <EdgeSegmentRow
        registry={facetRegistry}
        field="lineJumps"
        current={current.lineJumps}
        onPick={(value) => run({ kind: 'set-line-jumps', lineJumps: value as LineJumps })}
      />
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
  return facetPropertyItems(registry, 'inspector.node', ctx)
}

/**
 * The same doorway at any inspector point — the point decides whether there
 * is anything behind the door, so a surface with no facets registered for it
 * offers nothing rather than an empty panel.
 */
export function facetPropertyItems(
  registry: FacetRegistry,
  point: ContributionPoint,
  ctx: NodePropertiesContext,
): readonly ContextMenuItem[] {
  if (resolveFacetContributions(registry, point).length === 0) return []
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

/**
 * A canvas-target row DERIVED from the facet's own editor spec — the form
 * `facet-ui` builds from the schema and the `editor` block the plugin
 * declared, writing to the envelope. The vessel ADR-0030 named as the gap:
 * a facet with a declared editor and no component of its own reaches the
 * settings panel through here, so registering a theme is registering an
 * asset and nothing on this side.
 */
function derivedCanvasFacetRow(key: string, title: string): CanvasSettingsWidget {
  return ({ canvas, run, facetRegistry }) => (
    <DerivedFacetForm
      facetKey={key}
      title={title}
      stored={canvas['x-whiteboard']?.facets?.[key]}
      registry={facetRegistry}
      onWrite={(facetKey, payload) => run({ kind: 'set-canvas-facet', key: facetKey, payload })}
    />
  )
}

export const CANVAS_SETTINGS_WIDGETS: Readonly<Record<string, CanvasSettingsWidget>> = {
  'visual.edges/v0': visualEdgesPanel,
  // How the canvas is DRAWN (ADR-0030): a registered theme asset by id.
  'visual.theme/v0': derivedCanvasFacetRow('visual.theme/v0', 'Theme'),
  // The document's own mark — what its tab, its file row and, where there is
  // room, its overview draw instead of a picture derived from its contents.
  // Through the SAME derived row the other two take, now that the picker
  // vocabulary can express it: this was the one row drawn by a plugin
  // component, and the one that looked unlike its neighbours.
  'visual.symbol/v0': derivedCanvasFacetRow('visual.symbol/v0', 'Symbol'),
}
