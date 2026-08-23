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
  type FacetRegistry,
  resolveCanvasEdgeStyle,
  resolveFacetContributions,
  type VisualSymbolFacet,
  visualSymbolFacetSchema,
} from '@kamiazya/whiteboard-facet-engine'
import type { EdgeRoutingStyle, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { Ban, SlidersHorizontal } from 'lucide-react'
import { createElement, type ReactNode } from 'react'
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

/**
 * `inspector.node`: a hand-written editor for one facet, rendered inside the
 * inspector's row for it. Tier 3 of the editor ladder — for a picker the
 * declared vocabulary cannot yet express.
 *
 * `write` is the panel's own writer, so it has already been through
 * `validateFacetWrite`: a widget cannot store what `wb_facet_set` refuses.
 * `undefined` clears the facet.
 */
export interface FacetEditorContext {
  readonly value: unknown
  readonly write: (payload: unknown) => void
}

export type FacetEditorWidget = (ctx: FacetEditorContext) => ReactNode

// --- visual.shape/v0 -------------------------------------------------------

// --- visual.symbol/v0 ------------------------------------------------------

/**
 * The badge picker. Icons come from the RENDERER's vendored set, so the row
 * can never offer a name the canvas would silently drop; the emoji arm
 * carries a small starter set — a free-entry field is the editor-spec tier's
 * job, not a quick band's.
 */
const EMOJI_CHOICES = ['✅', '⚠️', '🔥', '⭐', '📌'] as const

const symbolEditor: FacetEditorWidget = ({ value, write }) => {
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
    <label
      key={key}
      className={cn(
        'flex h-7 min-w-7 cursor-pointer items-center justify-center rounded px-1 text-xs',
        on ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent',
      )}
    >
      <input
        type="radio"
        name="visual-symbol"
        aria-label={label}
        checked={on}
        onChange={() => write(payload)}
        className="sr-only"
      />
      <span aria-hidden="true" className="[&>svg]:size-4">
        {content}
      </span>
    </label>
  )
  return (
    <span role="radiogroup" aria-label="Symbol" className="flex flex-wrap items-center gap-0.5">
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

export const NODE_FACET_EDITORS: Readonly<Record<string, FacetEditorWidget>> = {
  // visual.shape and visual.text are NOT here: they declare their editor
  // (see visual.ts) and are rendered from that declaration. Only symbol
  // needs code, because an icon-plus-emoji picker is outside the declared
  // vocabulary — which is the gap the semantic layer is meant to close.
  'visual.symbol/v0': symbolEditor,
}

export const CANVAS_SETTINGS_WIDGETS: Readonly<Record<string, CanvasSettingsWidget>> = {
  'visual.edges/v0': visualEdgesPanel,
}
