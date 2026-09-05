import type { StateCommand } from '@codemirror/state'
import { Ellipsis } from 'lucide-react'
import { type MouseEvent as ReactMouseEvent, useEffect, useState } from 'react'
import { cn } from '../../lib/utils.js'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip.js'
import {
  cycleHeadingLevel,
  inVerbTableOrder,
  type MarkdownVerbId,
  selfContainedCommand,
  VERB_BAR_ORDER,
  verb,
} from './editor-verbs.js'
import { DESKTOP_BAR_METRICS, layoutVerbBar } from './verb-bar-layout.js'
import { VERB_ICONS } from './verb-icons.js'

const BAR_ITEMS = VERB_BAR_ORDER.map((id) => ({ id, band: verb(id).band }))

/**
 * The bar's own width, which as a `flex-1` item IS the room left for it.
 *
 * The observer is created ONCE per node, from an effect keyed on a node held
 * in state — never from the ref callback itself. An inline ref callback runs
 * on every render, and `observe()` delivers a callback immediately, so
 * re-observing there re-renders, which re-observes: a loop that runs one
 * iteration per frame for as long as the bar is mounted. It is not
 * self-limiting either, because the two ends measure different numbers —
 * `clientWidth` is rounded and `contentRect.width` is not, so at a
 * fractional width the two values never agree and the loop never settles.
 * That starves the whole page this bar is mounted in; it surfaced as typing
 * arriving truncated in page tests nowhere near this file.
 */
function useMeasuredWidth(): [(node: HTMLDivElement | null) => void, number] {
  const [node, setNode] = useState<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    if (node === null || typeof ResizeObserver === 'undefined') return
    const measure = () => setWidth((prev) => (prev === node.clientWidth ? prev : node.clientWidth))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [node])
  // `setNode` is a stable setState function, so React attaches this ref once
  // rather than on every render.
  return [setNode, width]
}

export interface MarkdownVerbBarProps {
  /** Runs a verb against whichever editor this bar belongs to. */
  readonly run: (command: StateCommand) => void
  /**
   * Opens the host's link picker and answers true; false when it has nothing
   * to pick from, so the verb falls back to its plain bracket wrap.
   */
  readonly openLinkPicker?: () => boolean
  /** Doorway for what the width could not hold. Absent -> no "…" is drawn. */
  readonly onOpenOverflow?: (anchor: { x: number; y: number }) => void
  readonly className?: string
}

/**
 * The editing verbs as a row, for a surface with room to show them — the
 * document editor's toolbar and the canvas's strip under the header.
 *
 * Formatting buttons were removed from the toolbar once, for two reasons
 * that have both since expired: they were redundant beside ⌘B, and a 28px
 * target at the top edge was the worst place to put the phone's only path
 * to them. The phone now has its own keyboard-docked bar, so the top edge is
 * nobody's only path; and the table has grown from six verbs to sixteen, of
 * which TEN have no chord at all (quote, code block, table, divider,
 * strikethrough, link, math, both lists, and the heading band). Those ten
 * were reachable through one popover and nowhere else.
 *
 * Icon-only, with the name in `aria-label` and a tooltip, matching both the
 * catalog this promotes out of and the touch bar it mirrors. Heading is one
 * slot that CYCLES rather than a band of four, so every verb is one slot
 * wide and `layoutVerbBar` has a uniform run to fit.
 */
export function MarkdownVerbBar({
  run,
  openLinkPicker,
  onOpenOverflow,
  className,
}: MarkdownVerbBarProps) {
  const [ref, width] = useMeasuredWidth()
  // Before the first measurement, showing nothing beats showing a bar that
  // reflows on the next frame.
  const layout = layoutVerbBar(width, BAR_ITEMS, DESKTOP_BAR_METRICS)
  const visible = width === 0 ? [] : inVerbTableOrder(layout.visible)

  // Keep the caret where it is: the verbs resolve their scope from the
  // editor's selection, and a focused button would take it away first.
  const keepCaret = (event: ReactMouseEvent) => event.preventDefault()

  const press = (id: MarkdownVerbId) => {
    const spec = verb(id)
    if (spec.action.kind === 'levels') {
      run(cycleHeadingLevel)
      return
    }
    if (spec.action.kind === 'interactive' && openLinkPicker?.() === true) return
    const command = selfContainedCommand(spec)
    if (command !== null) run(command)
  }

  return (
    <div
      ref={ref}
      data-testid="markdown-verb-bar"
      role="toolbar"
      aria-label="Formatting"
      className={cn('flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden', className)}
    >
      {visible.map((id, index) => {
        const spec = verb(id)
        const previous = index > 0 ? verb(visible[index - 1]) : undefined
        return (
          <div key={id} className="flex items-center">
            {previous !== undefined && previous.band !== spec.band && (
              <span aria-hidden="true" className="bg-border mx-[3px] h-4 w-px" />
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={spec.label}
                  onMouseDown={keepCaret}
                  onClick={() => press(id)}
                  className="text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-ring inline-flex size-7 items-center justify-center rounded-md transition-colors duration-(--motion-duration-fast) focus-visible:ring-2 focus-visible:outline-none"
                >
                  <span aria-hidden="true" className="[&>svg]:size-4">
                    {VERB_ICONS[id]}
                  </span>
                </button>
              </TooltipTrigger>
              <TooltipContent>{spec.label}</TooltipContent>
            </Tooltip>
          </div>
        )
      })}
      {onOpenOverflow !== undefined && layout.overflow.length > 0 && (
        <>
          <span aria-hidden="true" className="bg-border mx-[3px] h-4 w-px" />
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="More formatting"
                aria-haspopup="menu"
                onMouseDown={keepCaret}
                onClick={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect()
                  onOpenOverflow({ x: rect.left, y: rect.bottom })
                }}
                className="text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-ring inline-flex size-7 items-center justify-center rounded-md transition-colors duration-(--motion-duration-fast) focus-visible:ring-2 focus-visible:outline-none"
              >
                <Ellipsis aria-hidden className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent>More formatting</TooltipContent>
          </Tooltip>
        </>
      )}
    </div>
  )
}
