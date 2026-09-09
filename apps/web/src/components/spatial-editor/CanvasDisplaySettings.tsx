/**
 * Canvas-wide display settings as a PANEL. The document's ⋯ menu hangs it in
 * a popover off its own trigger, from the leading `Display…` row; this
 * module owns what is in the panel and nothing about how it is opened.
 *
 * It used to carry its own gear in the header row — the row's only VIEW
 * control, one icon for one plugin's edge routing, against width the title
 * wanted. Standalone from SpatialEditor so the PAGE places it; it speaks the
 * same (canvas, onChange) command contract the editor does.
 *
 * This surface OWNS the `canvasSettings` contribution point and knows no
 * facet domain (facet-wiring-guard.test.ts): panels come from the registry,
 * grouped per plugin namespace. With one contributing namespace the panel
 * renders bare; a second namespace introduces a tab strip headed by each
 * plugin's displayName (ordering stays namespace-id lexicographic — a
 * display name may be reworded or localized and must not move the order).
 *
 * Picks apply immediately and keep the popover open — these are property
 * pickers, and closing per pick would force a reopen for every adjustment,
 * which is also why the ⋯ row opens a popover rather than a submenu. Radix
 * owns dismissal (outside click, Escape) and returns focus to the kebab the
 * popover is anchored on, so a keyboard user never falls to <body>.
 */
import type { SpatialRenderStyle } from '@kamiazya/whiteboard-canvas-render'
import { type FacetRegistry, resolveFacetContributions } from '@kamiazya/whiteboard-facet-engine'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { bundledFacetRegistry } from '@kamiazya/whiteboard-plugin-visual'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import type { EditorCommand } from '../../lib/spatial/commands.js'
import { applyCommand } from '../../lib/spatial/commands.js'
import { cn } from '../../lib/utils.js'
import { CANVAS_SETTINGS_WIDGETS, type CanvasSettingsWidget } from './facet-widgets/index.js'

export interface CanvasDisplaySettingsProps {
  readonly canvas: SpatialCanvas
  readonly onChange: (next: SpatialCanvas, command: EditorCommand) => void
  /** Contribution source; a test seam — production uses the bundled registry. */
  readonly facetRegistry?: FacetRegistry
  /** Widget lookup; a test seam — production uses the registered widgets. */
  readonly widgets?: Readonly<Record<string, CanvasSettingsWidget>>
  /**
   * The session's look override (ADR-0030 decision 6), held by the host for
   * this tab: absent draws what the document says. The row is offered only
   * where a host passes `onStyleChange`, since a setting nobody can hold is
   * a control that does nothing.
   */
  readonly style?: SpatialRenderStyle
  readonly onStyleChange?: (style: SpatialRenderStyle | undefined) => void
}

const OPTION_CLASS =
  'flex h-7 min-w-7 items-center justify-center rounded px-2 text-xs transition-colors duration-(--motion-duration-fast) ease-(--motion-ease-out) hover:bg-accent focus-visible:bg-accent focus-visible:outline-none text-muted-foreground aria-pressed:font-medium aria-pressed:bg-accent aria-pressed:text-foreground'

/** A theme id's bare name, read for a person: `visual.sketch` → `sketch`. */
function themeLabel(id: string): string {
  return id.slice(id.indexOf('.') + 1)
}

export function CanvasDisplaySettings({
  canvas,
  onChange,
  facetRegistry = bundledFacetRegistry,
  widgets = CANVAS_SETTINGS_WIDGETS,
  style,
  onStyleChange,
}: CanvasDisplaySettingsProps) {
  // Eager command chaining: two picks from the same open popover can land
  // before a slow parent commits the first, and the second must build on
  // the first's result, not the stale prop. The ref follows the prop only
  // after the parent actually re-renders with it.
  const canvasRef = useRef(canvas)
  useEffect(() => {
    canvasRef.current = canvas
  }, [canvas])
  const run = (command: EditorCommand) => {
    const running = applyCommand(canvasRef.current, command)
    canvasRef.current = running
    onChange(running, command)
  }

  const groups = useMemo(
    () =>
      resolveFacetContributions(facetRegistry, 'canvasSettings')
        .map((group) => ({
          group,
          widgets: group.facets.flatMap((facet) => {
            const widget = widgets[facet.key]
            return widget === undefined ? [] : [{ key: facet.key, widget }]
          }),
        }))
        .filter((entry) => entry.widgets.length > 0),
    [facetRegistry, widgets],
  )

  const [activeNamespace, setActiveNamespace] = useState<string | null>(null)
  const active = groups.find((entry) => entry.group.namespace === activeNamespace) ?? groups[0]

  return (
    <>
      {groups.length >= 2 && (
        <div role="tablist" className="mb-2 flex items-center gap-1 border-b border-border">
          {groups.map(({ group }) => (
            <button
              key={group.namespace}
              type="button"
              role="tab"
              aria-selected={group.namespace === active?.group.namespace}
              onClick={() => setActiveNamespace(group.namespace)}
              className={cn(
                'rounded-t px-2 py-1 text-xs',
                group.namespace === active?.group.namespace
                  ? 'bg-accent font-medium text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {group.displayName}
            </button>
          ))}
        </div>
      )}
      {active?.widgets.map(({ key, widget }) => (
        <Fragment key={key}>{widget({ canvas, run, facetRegistry })}</Fragment>
      ))}
      {onStyleChange !== undefined && (
        // This tab's look, apart from the document's: the one row here that
        // writes nothing. The theme ids come from the registry's assets, so
        // a plugin that registers a theme gets its preview without this
        // surface naming it.
        <div className="mt-2 flex items-center justify-between gap-3 border-t border-border pt-2">
          <span className="text-xs text-muted-foreground">Draw as</span>
          <span className="flex flex-wrap items-center justify-end gap-0.5">
            {[
              { value: undefined, label: 'As saved' },
              { value: 'clean' as const, label: 'Clean' },
              ...facetRegistry
                .assetIds('themes')
                .map((id) => ({ value: id, label: `Preview ${themeLabel(id)}` })),
            ].map(({ value, label }) => (
              <button
                key={label}
                type="button"
                aria-pressed={style === value}
                onClick={() => onStyleChange(value)}
                className={OPTION_CLASS}
              >
                {label}
              </button>
            ))}
          </span>
        </div>
      )}
    </>
  )
}
