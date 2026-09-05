import { Minimize2 } from 'lucide-react'
import type { Ref } from 'react'
import { getAppLogger } from '../../lib/app-logger.js'
import { Button } from '../ui/button.js'

const log = getAppLogger('exit-fullscreen-control')

/**
 * The one way out while fullscreen has the top bar stepped aside. Escape and
 * the platform's own back gesture still work; this is what a pointer has.
 *
 * It sits on the BOTTOM edge because rotating puts the device's camera edge on
 * a SIDE of the screen and never its bottom. The web exposes the safe area
 * only as a uniform band per edge, never the cutout's position along it — so a
 * control on the top edge has to either collide with the punch-hole or step
 * back from the whole band on every device that has one, however far the
 * camera is from that corner. Both were seen on a phone. What is left down
 * here is the home indicator, a band that genuinely IS the full width, so
 * clearing it reads as intended rather than as a control that drifted. Left,
 * since the canvas keeps its overview at bottom-right.
 *
 * Lifted 70px because the bottom edge is where both editing surfaces keep a
 * strip of their own: that is the canvas dock's own 0.75rem offset, its 46px,
 * and the same gap again. The dock is a fixed 295px island, centred, so its
 * left edge walks toward the corner as the viewport narrows — x=33 at 360px
 * CSS, against this control's 12..48. The same offset clears the markdown
 * editor's formatting bar (44px), which is why it needs no branch on kind.
 *
 * The caller owns the ref: entering fullscreen unmounts the control that was
 * just activated, so focus has to be moved here rather than left on <body>.
 */
export function ExitFullscreenControl({ ref }: { ref?: Ref<HTMLButtonElement> }) {
  return (
    <Button
      ref={ref}
      variant="outline"
      size="icon"
      aria-label="Exit fullscreen"
      onClick={() =>
        document.exitFullscreen().catch((err) => log.warn('exitFullscreen failed', err))
      }
      className="absolute bottom-[calc(70px+env(safe-area-inset-bottom))] left-[calc(0.75rem+env(safe-area-inset-left))] z-20 bg-background/80 text-muted-foreground backdrop-blur hover:text-foreground"
    >
      <Minimize2 aria-hidden="true" className="size-4" />
    </Button>
  )
}
