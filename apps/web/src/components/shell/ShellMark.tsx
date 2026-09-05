/**
 * The signature mark, carrying the state of whoever keeps the open document.
 *
 * It says nothing while the keeper is keeping. A browser whose writes land
 * and a daemon whose session is up draw the plain stroke and no cap — the
 * routine state asks nothing of the person looking at it, and a mark that
 * lit up for it would be lit up always. What it draws is a CONDITION, each
 * one something a person could act on:
 *
 * - browser `stuck` — an edit has stayed unsaved past `STUCK_AFTER_MS`:
 *   filled amber cap.
 * - daemon `reconnecting` — the session dropped and is retrying: filled
 *   amber cap over `wb-loader`'s travelling dash, the loader mark's own
 *   gesture on this exact path (BRAND.md reads it as "the pen is moving").
 * - browser `failed` / daemon `sync-off` — the keeper is NOT keeping: the
 *   stroke sits broken and dimmed (`wb-mark-broken`). The daemon's cap is
 *   filled and the browser's is hollow, so the two read apart when both
 *   carry amber and the mark has no word to separate them. The word moves
 *   to the accessible name and the popover.
 *
 * Amber is the only tone left in chrome (DESIGN.md): "safe" is the absence
 * of a cap, not a colour, and a hollow ring rather than a second hue is what
 * separates "not keeping" from "not yet".
 */
import { useEffect, useRef, useState } from 'react'
import {
  type ConnectionState,
  isNotKeeping,
  type SessionHealth,
} from '../../lib/connection-state.js'
import type { StorageHealth } from '../../lib/storage-health.js'
import { cn } from '../../lib/utils.js'

/** The signature path, shared verbatim with `home-mark.svg` and `loader-mark.svg`. */
const SIGNATURE = 'M20 44 C 27 22, 37 22, 44 33 S 58 50, 68 25'

/**
 * The signature's own end point, in the 88×56 view box. The cap rides
 * there, so the mark reads as one stroke ending in a point rather than a
 * logo with a badge on it.
 */
const TERMINUS = { x: 68, y: 25 } as const

/**
 * How long the recovery gesture holds before the mark returns to rest.
 * Matched to the animation in index.css; a stray value here would leave the
 * gesture attribute set after the paint finished, which the next transition
 * would then fail to re-trigger.
 */
const RECOVERED_MS = 900

type CapShape = 'filled' | 'ring'

/**
 * What the cap draws for a state, or nothing. One table for both keepers,
 * so the vocabulary cannot drift between them the way three hand-copied
 * colour literals once did.
 */
function capOf(state: ConnectionState): CapShape | undefined {
  if (state.keeper === 'browser') {
    const by: Record<StorageHealth, CapShape | undefined> = {
      ok: undefined,
      stuck: 'filled',
      failed: 'ring',
    }
    return by[state.storage]
  }
  const by: Record<SessionHealth, CapShape | undefined> = {
    synced: undefined,
    reconnecting: 'filled',
    'sync-off': 'filled',
  }
  return by[state.session]
}

export interface ShellMarkProps {
  /**
   * Omitted when no page holds a live document. The mark then draws plain,
   * with no cap at all — the shell's standing rule is that it states a
   * connection only while a page holds one, and never latches the last.
   */
  readonly state?: ConnectionState
  readonly className?: string
}

function sessionOf(state: ConnectionState | undefined): SessionHealth | undefined {
  return state !== undefined && state.keeper === 'daemon' ? state.session : undefined
}

function storageOf(state: ConnectionState | undefined): StorageHealth | undefined {
  return state !== undefined && state.keeper === 'browser' ? state.storage : undefined
}

export function ShellMark({ state, className }: ShellMarkProps) {
  const session = sessionOf(state)
  const storage = storageOf(state)
  const [recovered, setRecovered] = useState(false)
  // The PREVIOUS session, so the gesture keys on a transition rather than on
  // a value. Keyed on the value alone, every re-render that happened to be
  // synced would replay it — and React re-renders for reasons of its own.
  const previous = useRef<SessionHealth | undefined>(session)

  useEffect(() => {
    const before = previous.current
    previous.current = session
    // Leaving synced ENDS the gesture, and clearing the flag is what makes
    // the next recovery playable: `setRecovered(true)` on a flag that is
    // already true is a no-op — React bails on identical state, the class
    // never leaves the DOM, and the animation therefore never restarts. A
    // connection that drops repeatedly would show the reassurance once and
    // then never again, which is the opposite of who needs it.
    if (session !== 'synced') {
      setRecovered(false)
      return
    }
    // Only a session that had DROPPED and came back. A first mount that is
    // already synced is not a recovery — celebrating it would make every
    // navigation twinkle, and spend the gesture before anything went wrong.
    // A keeper change is not one either: browser -> daemon is a move, with
    // its own narration, and no session dropped for it to come back from.
    if (before !== 'reconnecting' && before !== 'sync-off') return
    setRecovered(true)
    const timer = setTimeout(() => setRecovered(false), RECOVERED_MS)
    return () => clearTimeout(timer)
  }, [session])

  const cap = state === undefined ? undefined : capOf(state)
  const broken = state !== undefined && isNotKeeping(state)
  // Gated on the session as well as on the flag. `useEffect` is PASSIVE — it
  // runs after paint — so between the render that carries the new session and
  // the effect that clears the flag there is a real painted frame showing the
  // recovery gesture under a session that has just dropped. The flag clear is
  // what makes the NEXT recovery playable; this is what keeps the current one
  // from outliving its session by a frame. Deliberately not test-pinned: a
  // single pre-effect frame is not observable from jsdom, and asserting it
  // would need a browser test that catches one paint.
  const playingRecovery = recovered && session === 'synced'

  return (
    <svg
      data-testid="shell-mark"
      {...(state === undefined ? {} : { 'data-keeper': state.keeper })}
      {...(session === undefined ? {} : { 'data-session': session })}
      {...(storage === undefined ? {} : { 'data-storage': storage })}
      {...(playingRecovery ? { 'data-gesture': 'recovered' } : {})}
      viewBox="0 0 88 56"
      fill="none"
      aria-hidden="true"
      className={cn(
        'h-[16px] w-[26px] overflow-visible',
        playingRecovery && 'wb-mark-recovered',
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
          // Broken and dimmed: the keeper is not keeping and will not start
          // again on its own. Distinct from reconnecting's travel while
          // sharing its tone, which is the whole reason motion carries this.
          broken && 'wb-mark-broken',
          session === 'synced' && 'wb-mark-stroke',
        )}
      />
      {/* One-shot attention echo behind the cap: mounts exactly when the mark
          enters a not-keeping state, pulses twice, then rests. Finite by
          design — a standing ping would be noise, not guidance — and it is
          the failure direction's counterpart to the recovery gesture above.
          The keeper giving up is the one thing in this shell that has to be
          noticed. */}
      {broken && (
        <circle
          data-testid="shell-mark-pulse"
          cx={TERMINUS.x}
          cy={TERMINUS.y}
          r={8}
          className="wb-mark-cap animate-[attention-pulse_900ms_var(--motion-ease-out)_2] fill-amber-500"
        />
      )}
      {cap !== undefined && (
        <circle
          data-testid="shell-mark-cap"
          data-tone="attention"
          data-shape={cap}
          cx={TERMINUS.x}
          cy={TERMINUS.y}
          r={cap === 'ring' ? 6 : 8}
          className={cn(
            'wb-mark-cap',
            cap === 'filled' && 'fill-amber-500',
            cap === 'ring' && 'fill-none stroke-amber-500 [stroke-width:4]',
          )}
        />
      )}
    </svg>
  )
}
