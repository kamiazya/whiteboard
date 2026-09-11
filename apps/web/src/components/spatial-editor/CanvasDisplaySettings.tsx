/**
 * Canvas-wide display settings as a PANEL — the `display` member of the
 * page's one inspector slot (`lib/inspector.ts`). This module owns what is
 * in the panel and nothing about where it stands: `InspectorPanel` is the
 * vessel, a column beside the editor where there is width and a bottom
 * sheet under 768px.
 *
 * Standalone from SpatialEditor so the PAGE places it; it speaks the same
 * (canvas, onChange) command contract the editor does.
 *
 * Two vessels came before and each failed the same way, from the opposite
 * end of the row. First its own gear in the header — the row's only VIEW
 * control, one icon for one plugin's edge routing, against width the title
 * wanted. Then a popover hung off the ⋯ kebab, which on a phone could not
 * be dismissed at all: Radix takes an outside click or Escape, and at 424px
 * of panel against a 390px screen there is neither a keyboard nor much
 * outside. The slot answers both — the header spends no extra width,
 * because a spatial document has no `properties` member to draw, and the
 * sheet brings its own close.
 *
 * This surface OWNS the `canvasSettings` contribution point and knows no
 * facet domain (facet-wiring-guard.test.ts): panels come from the registry,
 * grouped per plugin namespace. With one contributing namespace the panel
 * renders bare; a second namespace introduces a tab strip headed by each
 * plugin's displayName (ordering stays namespace-id lexicographic — a
 * display name may be reworded or localized and must not move the order).
 *
 * Picks apply immediately and the panel stays open — these are property
 * pickers, and closing per pick would force a reopen for every adjustment.
 *
 * It carried a **Draw as** row too — ADR-0030 decision 6's session look
 * override, `As saved` / `Clean` / a preview per registered theme. Removed
 * (user decision, 2026-09-10): it was the panel's widest row and the one
 * that could not be drawn, since "preview neon" and "neon" differ by
 * whether the pick is SAVED, which no glyph says. Its `style` argument
 * survives at every render entry point as decision 6 describes — headless
 * defaults to `clean`, the editor to `document` — with no UI that sets it.
 */
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
}

export function CanvasDisplaySettings({
  canvas,
  onChange,
  facetRegistry = bundledFacetRegistry,
  widgets = CANVAS_SETTINGS_WIDGETS,
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
    </>
  )
}
