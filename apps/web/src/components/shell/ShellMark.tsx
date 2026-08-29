/**
 * The signature mark, carrying the live session's state.
 *
 * The shell used to answer "is my work safe" with a labelled chip on the
 * right while the mark sat on the left meaning nothing but "home". Two
 * carriers, and the row had no subject. This is the merge: the mark is the
 * one place the shell speaks about the workspace, and the chip is gone.
 *
 * The state vocabulary is deliberately borrowed rather than invented:
 *
 * - The TONE comes from `StateDot`'s closed set, so the mark cannot drift
 *   from the save chip and the version dot the way three hand-copied colour
 *   literals once did.
 * - `reconnecting` reuses `wb-loader` — the loader mark's travelling dash,
 *   on this exact same path (`loader-mark.svg` normalises it to 120 units
 *   for the same dash math). BRAND.md already reads that gesture as "the pen
 *   is moving, work is happening", which is what reconnecting means.
 *
 * That reuse is load-bearing, not tidiness: `reconnecting` and `sync-off`
 * are BOTH attention-toned in StateDot's set. The chip separated them with
 * its word; a mark has no word, so motion is what tells them apart — one
 * travels, one sits broken and dimmed.
 */
import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import type { ConnectionState, SessionHealth } from '../connection/ConnectionStatus.js'
import type { StateDotTone } from '../StateDot.js'

/** The signature path, shared verbatim with `home-mark.svg` and `loader-mark.svg`. */
const SIGNATURE = 'M20 44 C 27 22, 37 22, 44 33 S 58 50, 68 25'

/**
 * The signature's own end point, in the 88×56 view box. The state dot rides
 * it rather than floating beside the mark: the squiggle already ends in a
 * gesture, so the dot reads as its punctuation instead of as a second object
 * competing with it in a 40px row.
 */
const TERMINUS = { x: 68, y: 25 } as const

// Meaning, not paint — StateDot owns the palette (DESIGN.md's closed set).
const SESSION_TONE: Record<SessionHealth, StateDotTone> = {
  synced: 'safe',
  reconnecting: 'attention',
  'sync-off': 'attention',
}

const TONE_FILL: Record<StateDotTone, string> = {
  safe: 'fill-emerald-500',
  attention: 'fill-amber-500',
  neutral: 'fill-muted-foreground/60',
}

/**
 * How long the recovery gesture holds before the mark returns to rest.
 * Matched to the animation in index.css; a stray value here would leave the
 * gesture attribute set after the paint finished, which the next transition
 * would then fail to re-trigger.
 */
const RECOVERED_MS = 900

export interface ShellMarkProps {
  /**
   * Omitted when no page holds a live session. The mark then draws plain,
   * with no dot at all — the shell's standing rule is that it states a
   * connection only while a page holds one, and never latches the last.
   */
  readonly state?: ConnectionState
  readonly className?: string
}

function toneOf(state: ConnectionState): StateDotTone {
  return state.keeper === 'browser' ? 'neutral' : SESSION_TONE[state.session]
}

function sessionOf(state: ConnectionState | undefined): SessionHealth | undefined {
  return state !== undefined && state.keeper === 'daemon' ? state.session : undefined
}

export function ShellMark({ state, className }: ShellMarkProps) {
  const session = sessionOf(state)
  const [recovered, setRecovered] = useState(false)
  // The PREVIOUS session, so the gesture keys on a transition rather than on
  // a value. Keyed on the value alone, every re-render that happened to be
  // synced would replay it — and React re-renders for reasons of its own.
  const previous = useRef<SessionHealth | undefined>(session)

  useEffect(() => {
    const before = previous.current
    previous.current = session
    // Only a session that had DROPPED and came back. A first mount that is
    // already synced is not a recovery — celebrating it would make every
    // navigation twinkle, and spend the gesture before anything went wrong.
    // A keeper change is not one either: browser -> daemon is a move, with
    // its own narration, and no session dropped for it to come back from.
    if (session !== 'synced') return
    if (before !== 'reconnecting' && before !== 'sync-off') return
    setRecovered(true)
    const timer = setTimeout(() => setRecovered(false), RECOVERED_MS)
    return () => clearTimeout(timer)
  }, [session])

  const tone = state === undefined ? undefined : toneOf(state)

  return (
    <svg
      data-testid="shell-mark"
      {...(state === undefined ? {} : { 'data-keeper': state.keeper })}
      {...(session === undefined ? {} : { 'data-session': session })}
      {...(recovered ? { 'data-gesture': 'recovered' } : {})}
      viewBox="0 0 88 56"
      fill="none"
      aria-hidden="true"
      className={cn(
        'h-[16px] w-[26px] overflow-visible',
        recovered && 'wb-mark-recovered',
        className,
      )}
    >
      {/* The faint track the travelling dash runs on, exactly as the loader
          mark draws it. Only while reconnecting: at rest there is one stroke,
          and a permanent ghost behind it would thicken the mark. */}
      {session === 'reconnecting' && (
        <path
          pathLength={120}
          d={SIGNATURE}
          stroke="currentColor"
          strokeOpacity={0.25}
          strokeWidth={8}
          strokeLinecap="round"
        />
      )}
      <path
        data-testid="shell-mark-stroke"
        pathLength={120}
        d={SIGNATURE}
        stroke="currentColor"
        strokeWidth={8}
        strokeLinecap="round"
        className={cn(
          session === 'reconnecting' && 'wb-loader',
          // Broken and dimmed: the session was rejected and is not coming
          // back on its own. Distinct from reconnecting's travel while
          // sharing its tone, which is the whole reason motion carries this.
          session === 'sync-off' && 'wb-mark-broken',
          session === 'synced' && 'wb-mark-stroke',
        )}
      />
      {/* One-shot attention echo behind the cap: mounts exactly when the mark
          enters sync-off, pulses twice, then rests. Finite by design — a
          standing ping would be noise, not guidance — and it is the failure
          direction's counterpart to the recovery gesture above. Carried over
          from the chip verbatim, including its keyframe: sync-off arriving is
          the one thing in this shell that has to be noticed. */}
      {session === 'sync-off' && (
        <circle
          data-testid="shell-mark-pulse"
          cx={TERMINUS.x}
          cy={TERMINUS.y}
          r={8}
          className="wb-mark-cap animate-[attention-pulse_900ms_var(--motion-ease-out)_2] fill-amber-500"
        />
      )}
      {tone !== undefined && (
        <circle
          data-testid="shell-mark-cap"
          data-tone={tone}
          cx={TERMINUS.x}
          cy={TERMINUS.y}
          r={8}
          className={cn('wb-mark-cap', TONE_FILL[tone])}
        />
      )}
    </svg>
  )
}
