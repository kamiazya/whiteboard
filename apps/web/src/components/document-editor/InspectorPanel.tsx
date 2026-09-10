/**
 * The vessel every inspector panel stands in — the one `aside` of
 * `DocumentPageShell`, showing whichever panel the page's inspector slot
 * holds (`lib/inspector.ts`).
 *
 * A COLUMN of the editor row where there is width for one, a bottom sheet
 * over the editor under 768px. The history panel arrived at that shape
 * first: a 300px column beside a 375px phone editor is two unusable halves,
 * so under 768px the same panel is a sheet anchored to the bottom edge, out
 * of flow, with two stages. The PEEK stage is the load-bearing one —
 * looking at a past version draws it in place of the editor, and on a phone
 * that is only worth anything if the sheet leaves the document above it
 * visible while you choose. The FULL stage is for reading a long list, where
 * the document behind it has nothing to say. The comments rail then copied
 * the shape verbatim; this is the copy folded back into one place, so a
 * third and fourth panel could not drift from it.
 *
 * Position-agnostic within that: the shell's `aside` slot owns where the
 * panel sits, and the sheet positions against the row the shell wraps.
 *
 * MOTION lives here for the same reason the two shapes do: all four panes
 * stand in this one vessel, so a fifth inherits the way a pane arrives
 * instead of restating it. What is deliberately NOT animated is the
 * COLUMN'S WIDTH — measured, not chosen. `MarkdownEditor` observes its
 * container width, feeds it to `previewWidth`, and re-typesets the preview
 * whenever it changes (that value is a dependency of the typeset effect);
 * it also flips split -> write below `SPLIT_MIN_WIDTH` (640). An animated
 * in-flow width would therefore re-typeset the document on every frame of
 * the animation AND cross that threshold mid-slide, changing the editor's
 * MODE as a side effect of a panel opening. The column takes its width in
 * one step, as it always did, and its content slides into the space.
 */

import { ChevronUp, X } from 'lucide-react'
import type { ReactNode, Ref } from 'react'
import { useLayoutEffect, useRef, useState } from 'react'
import { useInspectorPresence } from '../../contexts/inspector-presence.js'
import { INSPECTOR_CHROME, type InspectorKind } from '../../lib/inspector.js'
import { cn } from '../../lib/utils.js'
import { HEADER_BUTTON_CLASS } from '../ui/header-button.js'

export function InspectorPanel({
  kind,
  onClose,
  panelRef,
  children,
}: {
  readonly kind: InspectorKind
  /** Releases the slot — the sheet's own way out, since its opener is up in the header. */
  readonly onClose: () => void
  readonly panelRef?: Ref<HTMLDivElement>
  readonly children: ReactNode
}) {
  const [expanded, setExpanded] = useState(false)
  const presence = useInspectorPresence()
  const root = useRef<HTMLDivElement | null>(null)
  // Captured ONCE, at mount: a pane that took over an occupied slot plays
  // no entrance. Reading `presence` per render instead would flip the class
  // mid-animation and cut the very entrance this protects.
  const [replacing] = useState(presence.slotWasOccupied)

  // Let go AT ONCE when nothing is actually animating.
  //
  // The exit is driven by `animationend`, which is the right signal when an
  // animation runs — but it never fires where none does: jsdom runs no CSS
  // animations at all, and a build that dropped the animation utilities
  // would behave the same. Without this the pane sits on screen, covering
  // the editor, until the shell's ceiling fires a second later. Asked after
  // a frame, because the class that starts the animation lands with this
  // render and the animation is not registered until the next one.
  useLayoutEffect(() => {
    if (presence.state !== 'closed') return
    const element = root.current
    if (element === null || typeof element.getAnimations !== 'function') {
      presence.onLeft()
      return
    }
    const frame = requestAnimationFrame(() => {
      if (element.getAnimations().length === 0) presence.onLeft()
    })
    return () => cancelAnimationFrame(frame)
  }, [presence])
  const { label, testId } = INSPECTOR_CHROME[kind]
  const lower = label.toLowerCase()
  return (
    <div
      ref={(node) => {
        root.current = node
        if (typeof panelRef === 'function') panelRef(node)
        else if (panelRef !== null && panelRef !== undefined) panelRef.current = node
      }}
      data-testid={testId}
      data-stage={expanded ? 'full' : 'peek'}
      // `replaced` rather than `open` for a pane that took over from
      // another: the entrance fades in from nothing, which is right for an
      // arrival into an EMPTY slot and wrong here, because the outgoing
      // pane leaves in the same commit and for those frames nothing covers
      // what is under the slot — the canvas dock showed through for about
      // five frames. Still an ordinary `data-state` so the exit, which is
      // the same either way, keeps its one selector.
      data-state={presence.state === 'closed' ? 'closed' : replacing ? 'replaced' : 'open'}
      // The shell is holding this pane past its own unmount so this can
      // run; telling it the animation is over is what lets it go. Guarded
      // on the target because a child's animation bubbles here too — the
      // stage chevron's rotate would otherwise drop the pane mid-exit.
      onAnimationEnd={(event) => {
        if (presence.state === 'closed' && event.target === event.currentTarget) {
          presence.onLeft()
        }
      }}
      className={cn(
        'absolute inset-x-0 bottom-0 z-20 flex min-h-0 flex-col border-t bg-background shadow-[0_-8px_24px_-12px_rgb(0_0_0/0.35)]',
        expanded ? 'h-full' : 'h-[45%] rounded-t-2xl',
        'md:static md:z-auto md:h-auto md:w-[300px] md:max-w-[calc(100vw-1.5rem)] md:shrink-0 md:rounded-none md:border-t-0 md:border-l md:shadow-none',
        // The panel arrives with motion, in the vocabulary the dialogs
        // already speak (tw-animate-css over this app's own motion tokens)
        // — one convention for "a surface appeared", not two.
        //
        // The two shapes enter from where they LIVE: the sheet rises off
        // the bottom edge it is anchored to, and the column slides in from
        // the edge it borders. Both fade, so the first frame is not a slab
        // of background over the editor.
        // `--motion-ease-enter` / `-exit`, NOT `--motion-ease-out`: what
        // changes here is mostly opacity, and that token is shaped for a
        // move. Measured on this panel before the swap — opacity 0.61 at
        // 30ms and 0.85 at 60ms of a 220ms animation, so it read as a flash
        // rather than a rise. The same measurement was taken on the comment
        // pin's ramp earlier and reached the same pair.
        'duration-(--motion-duration-normal)',
        'data-[state=open]:ease-(--motion-ease-enter) data-[state=closed]:ease-(--motion-ease-exit)',
        'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-bottom-4',
        'md:data-[state=open]:slide-in-from-bottom-0 md:data-[state=open]:slide-in-from-right-4',
        // And back out the way it came in — HOLDING where it ended, which
        // `animate-out` does not do on its own. Without a fill the element
        // reverts to its natural state the instant the animation ends, and
        // React needs a further commit to remove it; that gap gets painted.
        // Measured frame by frame on the closing sheet at 390px: twelve
        // monotone frames (top 479.6 -> 495.2, opacity 1.00 -> 0.02, height
        // constant), then ONE frame back at top 479.6 and opacity 1.00 with
        // no animation left, then gone. It reads as the sheet jumping back
        // up before it disappears.
        'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-bottom-4 data-[state=closed]:fill-mode-forwards',
        'md:data-[state=closed]:slide-out-to-bottom-0 md:data-[state=closed]:slide-out-to-right-4',
        // Stage: 45% -> 100% and back. Safe to transition because BOTH
        // ends are definite — an `auto` end would not animate at all, which
        // is the usual reason a height transition is said not to work.
        // The stage change IS a move (the sheet's edge travels), so it
        // keeps the move curve.
        'transition-[height] duration-(--motion-duration-normal) ease-(--motion-ease-out) md:transition-none',
      )}
    >
      <div className="flex shrink-0 items-center justify-between gap-2 px-2 pt-1.5 md:hidden">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <button
          type="button"
          data-testid={`${kind}-stage-toggle`}
          aria-label={expanded ? `Collapse ${lower}` : `Expand ${lower}`}
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          // The sheet's grab handle: a wide, shallow target a thumb aims at
          // the edge for, not an icon-sized one. One chevron, turned by the
          // ARIA state rather than swapped for another glyph, so the
          // announced state and the drawn one cannot disagree.
          className="flex h-6 w-16 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground aria-expanded:[&>svg]:rotate-180"
        >
          <ChevronUp aria-hidden="true" className="size-4 transition-transform" />
        </button>
        <button
          type="button"
          aria-label={`Close ${lower}`}
          onClick={onClose}
          className={cn(HEADER_BUTTON_CLASS, 'ml-auto')}
        >
          <X aria-hidden="true" className="size-4" />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">{children}</div>
    </div>
  )
}
