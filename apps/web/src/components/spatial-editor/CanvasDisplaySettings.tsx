/**
 * Canvas-wide display settings (edge routing style, line jumps) as a gear
 * popover for the canvas header row. Standalone from SpatialEditor so the
 * PAGE places it with the other canvas-level chrome; it speaks the same
 * (canvas, onChange) command contract the editor does.
 *
 * Picks apply immediately and keep the popover open — these are property
 * pickers, and closing per pick would force a reopen for every adjustment.
 * Radix owns dismissal (outside click, Escape) and returns focus to the
 * gear, so a keyboard user never falls to <body>.
 */
import type { EdgeRoutingStyle, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { SlidersHorizontal } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.js'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip.js'
import type { EditorCommand } from './commands.js'
import { applyCommand } from './commands.js'

export interface CanvasDisplaySettingsProps {
  readonly canvas: SpatialCanvas
  readonly onChange: (next: SpatialCanvas, command: EditorCommand) => void
}

const EDGE_ROUTING_CHOICES: readonly { style: EdgeRoutingStyle; label: string }[] = [
  { style: 'straight', label: 'Straight' },
  { style: 'orthogonal', label: 'Orthogonal' },
  { style: 'curved', label: 'Curved' },
]

const OPTION_CLASS =
  'flex h-7 min-w-7 items-center justify-center rounded px-2 text-xs transition-colors duration-(--motion-duration-fast) ease-(--motion-ease-out) hover:bg-accent focus-visible:bg-accent focus-visible:outline-none'

export function CanvasDisplaySettings({ canvas, onChange }: CanvasDisplaySettingsProps) {
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

  const currentRouting = canvas['x-whiteboard']?.edgeRouting?.style ?? 'straight'
  const currentJumps = canvas['x-whiteboard']?.edgeRouting?.lineJumps ?? 'none'

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
      </PopoverContent>
    </Popover>
  )
}
