import { cn } from '@/lib/utils'

/**
 * What the dot is saying, not what colour to paint.
 *
 * DESIGN.md keeps stateful colour in chrome to a closed, named set. That set
 * used to live only in prose, with each carrier holding its own copy of the
 * emerald/amber literals — which is how two carriers ended up identical while
 * answering different questions. The set lives here now, so a new carrier
 * picks a MEANING and inherits the paint.
 */
export type StateDotTone = 'safe' | 'attention' | 'neutral'

/**
 * The dot's shape, which is what separates two carriers that share a tone.
 *
 * `filled` is a state the document is IN (saved, synced). `ring` is a state
 * the document is NOT in yet — something the user could still do, like taking
 * a version. `spinner` is that same ring, turning, while the doing is in
 * flight.
 */
export type StateDotShape = 'filled' | 'ring' | 'spinner'

const TONE_FILL: Record<StateDotTone, string> = {
  safe: 'bg-emerald-500',
  attention: 'bg-amber-500',
  neutral: 'bg-muted-foreground/60',
}

const TONE_STROKE: Record<StateDotTone, string> = {
  safe: 'border-emerald-500',
  attention: 'border-amber-500',
  neutral: 'border-muted-foreground/60',
}

export interface StateDotProps {
  readonly tone: StateDotTone
  readonly shape?: StateDotShape
  /**
   * One-shot attention echo: pulses twice on entry, then rests. For a state
   * that ARRIVED and wants noticing (a failed write, a dropped sync) — never
   * for a resting state, which would make the header twitch forever.
   */
  readonly pulse?: boolean
  /**
   * The pulse's own test id. Per carrier, not shared: the connection chip and
   * the save chip can both be on screen at once, so one id for both would be
   * ambiguous exactly where it matters.
   */
  readonly pulseTestId?: string
  readonly className?: string
}

/**
 * The one dot the header's state carriers are drawn from — the connection
 * chip, the save-state chip, and the version dot.
 *
 * Deliberately not a chip or a button: each carrier owns its own trigger,
 * label and popover, because what you can DO about a state differs per
 * carrier. Only the paint and the shape are shared, and they are exactly what
 * drifted when each carrier kept its own.
 */
export function StateDot({
  tone,
  shape = 'filled',
  pulse = false,
  pulseTestId = 'state-dot-pulse',
  className,
}: StateDotProps) {
  return (
    <span aria-hidden="true" className={cn('relative inline-flex size-2', className)}>
      {pulse && (
        <span
          data-testid={pulseTestId}
          className={cn(
            'absolute inset-0 rounded-full',
            TONE_FILL[tone],
            'animate-[attention-pulse_900ms_var(--motion-ease-out)_2]',
          )}
        />
      )}
      <span
        data-testid="state-dot"
        className={cn(
          'absolute inset-0 rounded-full',
          // The tone CROSSES rather than cuts. A save cycle flips this dot
          // every debounce period while someone types, and at an instant
          // swap that reads as flicker beside the title being edited. It
          // also softens the case an instant swap makes worst: a write
          // faster than this duration never reaches the far colour at all,
          // so a quick save shimmers instead of flashing.
          'transition-colors duration-(--motion-duration-normal) ease-(--motion-ease-out)',
          shape === 'filled' && TONE_FILL[tone],
          shape !== 'filled' && cn('border-2', TONE_STROKE[tone]),
          // The ring's own gap is what reads as "not yet"; spinning it is the
          // same shape mid-action rather than a third vocabulary.
          shape === 'spinner' && 'border-t-transparent animate-spin',
        )}
      />
    </span>
  )
}
