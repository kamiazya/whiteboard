/**
 * Canvas-wide display settings as a gear popover for the canvas header row.
 * Standalone from SpatialEditor so the PAGE places it with the other
 * canvas-level chrome; it speaks the same (canvas, onChange) command
 * contract the editor does.
 *
 * This surface OWNS the `canvasSettings` contribution point and knows no
 * facet domain (facet-wiring-guard.test.ts): panels come from the registry,
 * grouped per plugin namespace. With one contributing namespace the panel
 * renders bare; a second namespace introduces a tab strip headed by each
 * plugin's displayName (ordering stays namespace-id lexicographic — a
 * display name may be reworded or localized and must not move the order).
 *
 * Picks apply immediately and keep the popover open — these are property
 * pickers, and closing per pick would force a reopen for every adjustment.
 * Radix owns dismissal (outside click, Escape) and returns focus to the
 * gear, so a keyboard user never falls to <body>.
 */
import { type FacetRegistry, resolveFacetContributions } from '@kamiazya/whiteboard-facet-engine'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { bundledFacetRegistry } from '@kamiazya/whiteboard-plugin-visual'
import { SlidersHorizontal } from 'lucide-react'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.js'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip.js'
import type { EditorCommand } from './commands.js'
import { applyCommand } from './commands.js'
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
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              data-testid="canvas-settings-button"
              aria-label="Display settings"
              className="text-muted-foreground hover:text-foreground shrink-0 rounded p-1.5"
            >
              <SlidersHorizontal aria-hidden="true" className="size-4" />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>Display settings</TooltipContent>
      </Tooltip>
      <PopoverContent data-testid="canvas-settings-menu" className="w-auto min-w-52 p-2">
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
          <Fragment key={key}>{widget({ canvas, run })}</Fragment>
        ))}
      </PopoverContent>
    </Popover>
  )
}
