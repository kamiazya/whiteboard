/**
 * The gesture flight recorder: a bounded, always-on ring of what the pointer
 * pipeline saw and what the navigation machine answered.
 *
 * It exists for the failure that cannot be reproduced on demand — "the hand
 * tool sometimes does not respond" on a phone, noticed only after the press
 * that died. A recorder the user has to arm first records nothing, so this
 * one always runs; what makes that acceptable is what it holds: event kinds,
 * coordinates, element test-ids and mode names. Never document content.
 *
 * Because `reduceNavigation` is pure and its events are plain data, a
 * serialized trace REPLAYS: fold the reducer over the recorded events and
 * the machine's decisions are reproduced away from the device that made
 * them. That fold is `replayNavigation`, and it is the reason the recorder
 * stores whole `NavigationEvent`s rather than a prose summary.
 *
 * The singleton below deliberately outlives every component — the exact
 * lifetime this editor's state discipline forbids elsewhere. A flight
 * recorder that unmounts with the crash it recorded is decoration; the ring
 * is bounded, so surviving costs a fixed few KB.
 */
import {
  createIdleNavigation,
  type NavigationEvent,
  type NavigationResult,
  type NavigationState,
  reduceNavigation,
} from './navigation.js'

/** Where a pointer landed, compressed to what a reader can act on. */
export interface TargetDescriptor {
  readonly tag: string
  readonly testId?: string
  readonly label?: string
  /** The `data-editor-overlay` ancestor that would swallow a press, if any. */
  readonly overlay?: string
}

export type TraceEntry =
  | {
      kind: 'navigation'
      at: number
      /** When the newest coalesced move landed; absent until one does. */
      lastAt?: number
      /** Further moves merged into this entry — see recordNavigation. */
      coalescedMoves: number
      event: NavigationEvent
      modeBefore: string
      modeAfter: string
      effects: readonly string[]
      fallThrough: boolean
    }
  | {
      kind: 'doc-pointer'
      at: number
      type: string
      pointerId: number
      pointerType: string
      isPrimary: boolean
      x: number
      y: number
      /** False is the finding: a press some portal took before the editor could see it. */
      insideRoot: boolean
      target: TargetDescriptor
    }
  | {
      kind: 'overlay-rejected'
      at: number
      pointerId: number
      pointerType: string
      target: TargetDescriptor
    }
  | { kind: 'lost-capture'; at: number; pointerId: number }
  /** The one place the component resets the machine outside the reducer. */
  | { kind: 'reset'; at: number; reason: string }

export interface RecordedNavigation {
  readonly at: number
  readonly event: NavigationEvent
  readonly before: NavigationState
  readonly result: NavigationResult
}

export interface GestureTrace {
  recordNavigation(record: RecordedNavigation): void
  recordDocPointer(entry: Omit<Extract<TraceEntry, { kind: 'doc-pointer' }>, 'kind'>): void
  recordOverlayRejected(
    entry: Omit<Extract<TraceEntry, { kind: 'overlay-rejected' }>, 'kind'>,
  ): void
  recordLostCapture(pointerId: number, at: number): void
  recordReset(reason: string, at: number): void
  entries(): readonly TraceEntry[]
  serialize(): string
}

/** Effects that mean "the same gesture, continuing" rather than a decision. */
const CONTINUATION_EFFECTS = new Set(['pan', 'pinch'])

export function createGestureTrace(capacity = 200): GestureTrace {
  const ring: TraceEntry[] = []

  const push = (entry: TraceEntry) => {
    ring.push(entry)
    if (ring.length > capacity) ring.splice(0, ring.length - capacity)
  }

  return {
    recordNavigation(record) {
      const { at, event, before, result } = record
      const modeAfter = result.state.mode.kind
      const effects = result.effects.map((effect) => effect.kind)
      // One pan is a decision; the 200 moves that continue it are not, and
      // at one entry each they would evict the press this recorder exists
      // to keep. A move that changes nothing but the viewport merges into
      // the entry that started it, counted rather than kept.
      const last = ring[ring.length - 1]
      if (
        event.type === 'pointermove' &&
        last !== undefined &&
        last.kind === 'navigation' &&
        // Only into a previous MOVE: a press's effect list can be empty, and
        // an empty list passes the continuation check vacuously — measured,
        // the first move of every drag merged into its press until this line.
        last.event.type === 'pointermove' &&
        last.modeAfter === modeAfter &&
        !result.fallThrough &&
        !last.fallThrough &&
        effects.every((effect) => CONTINUATION_EFFECTS.has(effect)) &&
        last.effects.every((effect) => CONTINUATION_EFFECTS.has(effect))
      ) {
        last.coalescedMoves += 1
        last.lastAt = at
        return
      }
      push({
        kind: 'navigation',
        at,
        coalescedMoves: 0,
        event,
        modeBefore: before.mode.kind,
        modeAfter,
        effects,
        fallThrough: result.fallThrough,
      })
    },
    recordDocPointer(entry) {
      push({ kind: 'doc-pointer', ...entry })
    },
    recordOverlayRejected(entry) {
      push({ kind: 'overlay-rejected', ...entry })
    },
    recordLostCapture(pointerId, at) {
      push({ kind: 'lost-capture', at, pointerId })
    },
    recordReset(reason, at) {
      push({ kind: 'reset', at, reason })
    },
    entries() {
      return ring.slice()
    },
    serialize() {
      return JSON.stringify({
        recordedAt: new Date().toISOString(),
        // The recorder module's own URL: hash-named in a production build,
        // which is what tells a trace from a stale service-worker bundle
        // apart from one running the deploy it claims to.
        bundle: import.meta.url,
        userAgent: typeof navigator === 'undefined' ? 'unknown' : navigator.userAgent,
        viewport:
          typeof window === 'undefined'
            ? undefined
            : {
                width: window.innerWidth,
                height: window.innerHeight,
                dpr: window.devicePixelRatio,
              },
        entries: ring,
      })
    },
  }
}

/**
 * Folds the reducer over a trace's navigation entries — one mode per entry,
 * resets applied where they were recorded. Coalescing keeps only the first
 * move of a run, so the fold sees fewer moves than the device did; every
 * merged move left the mode unchanged by construction, which is why
 * comparing MODE KINDS is sound and comparing pan positions would not be.
 */
export function replayNavigation(entries: readonly TraceEntry[]): string[] {
  let state = createIdleNavigation()
  const modes: string[] = []
  for (const entry of entries) {
    if (entry.kind === 'reset') {
      state = createIdleNavigation()
      continue
    }
    if (entry.kind !== 'navigation') continue
    state = reduceNavigation(state, entry.event).state
    modes.push(state.mode.kind)
  }
  return modes
}

/** Compresses an event target to the identity a trace reader can act on. */
export function describeTarget(target: EventTarget | null): TargetDescriptor {
  if (!(target instanceof Element)) return { tag: '?' }
  const overlay = target.closest('[data-editor-overlay]')
  const overlayName =
    overlay === null
      ? undefined
      : (overlay.getAttribute('data-testid') ??
        overlay.getAttribute('aria-label') ??
        overlay.tagName.toLowerCase())
  const carrier = target.closest('[data-testid]')
  return {
    tag: target.tagName.toLowerCase(),
    testId: carrier?.getAttribute('data-testid') ?? undefined,
    label: target.getAttribute('aria-label') ?? undefined,
    overlay: overlayName,
  }
}

/** The flight recorder. One per page on purpose — see the module docstring. */
export const gestureTrace: GestureTrace = createGestureTrace()
