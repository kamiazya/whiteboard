/**
 * The gesture flight recorder: a bounded, always-on ring of what the pointer
 * pipeline saw and what the navigation machine answered.
 *
 * It exists for the failure that cannot be reproduced on demand — "the hand
 * tool sometimes does not respond" on a phone, noticed only after the press
 * that died. A recorder the user has to arm first records nothing, so this
 * one always runs; what makes that acceptable is what it holds: event kinds,
 * coordinates, element tags, test-ids and roles, and mode names — never an
 * accessible name, which interpolates titles and URLs. Never document content.
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
import { z } from 'zod'
import {
  createIdleNavigation,
  type NavigationEvent,
  type NavigationResult,
  type NavigationState,
  reduceNavigation,
} from './navigation.js'

/**
 * The serialized trace's format. A trace is recorded by whatever bundle the
 * device runs — often a stale service-worker one — and read by a developer's
 * current reducer, so the two disagree exactly when it matters. Bump this
 * whenever the shape below changes meaning, not only when it changes keys.
 */
const GESTURE_TRACE_FORMAT = 1

// Every object below is strict: a field this build does not know is a field
// the replay would silently drop, which is a different event than the one
// the device saw.
const pointSchema = z.strictObject({ x: z.number(), y: z.number() }).readonly()
const pointerKindSchema = z.enum(['mouse', 'pen', 'touch'])

// `navigation.ts` owns the event types; this mirrors them for the one place
// they arrive as untrusted text, and gesture-trace.test.ts pins the two equal.
const pressContextSchema = z
  .strictObject({
    handMode: z.boolean(),
    spaceDown: z.boolean(),
    // JSON drops an undefined value, so the key may be absent on the wire;
    // the reducer's type requires it present, so it is restored here.
    hitId: z.string().optional(),
    anchorPrimaryId: z.string().nullable(),
    manipulating: z.boolean(),
  })
  .transform(({ hitId, ...rest }) => ({ ...rest, hitId }))
  .readonly()

const navigationEventSchema = z.discriminatedUnion('type', [
  z
    .strictObject({
      type: z.literal('pointerdown'),
      pointerId: z.number(),
      pointerType: pointerKindSchema,
      isPrimary: z.boolean(),
      button: z.number(),
      point: pointSchema,
      timeStamp: z.number(),
      context: pressContextSchema,
    })
    .readonly(),
  z
    .strictObject({
      type: z.literal('pointermove'),
      pointerId: z.number(),
      pointerType: pointerKindSchema,
      point: pointSchema,
    })
    .readonly(),
  z
    .strictObject({
      type: z.literal('pointerup'),
      pointerId: z.number(),
      pointerType: pointerKindSchema,
    })
    .readonly(),
  z.strictObject({ type: z.literal('external-press'), pointerId: z.number() }).readonly(),
  z
    .strictObject({
      type: z.literal('pointercancel'),
      pointerId: z.number(),
      pointerType: pointerKindSchema,
    })
    .readonly(),
])

/** Where a pointer landed, compressed to what a reader can act on. */
const targetDescriptorSchema = z
  .strictObject({
    tag: z.string(),
    testId: z.string().optional(),
    /**
     * The element's explicit ARIA role. Never its accessible name: names
     * interpolate content (`Load ${url}`, `Editing ${title}`), and this
     * recorder promises to hold none.
     */
    role: z.string().optional(),
    /** The `data-editor-overlay` ancestor that would swallow a press, if any. */
    overlay: z.string().optional(),
  })
  .readonly()

export type TargetDescriptor = z.infer<typeof targetDescriptorSchema>

const traceEntrySchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('navigation'),
    at: z.number(),
    /** When the newest coalesced move landed; absent until one does. */
    lastAt: z.number().optional(),
    /** Further moves merged into this entry — see recordNavigation. */
    coalescedMoves: z.number(),
    event: navigationEventSchema,
    modeBefore: z.string(),
    modeAfter: z.string(),
    effects: z.array(z.string()).readonly(),
    fallThrough: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal('doc-pointer'),
    at: z.number(),
    type: z.string(),
    pointerId: z.number(),
    pointerType: z.string(),
    isPrimary: z.boolean(),
    x: z.number(),
    y: z.number(),
    /** False is the finding: a press some portal took before the editor could see it. */
    insideRoot: z.boolean(),
    target: targetDescriptorSchema,
  }),
  z.strictObject({
    kind: z.literal('overlay-rejected'),
    at: z.number(),
    pointerId: z.number(),
    pointerType: z.string(),
    target: targetDescriptorSchema,
  }),
  z.strictObject({ kind: z.literal('lost-capture'), at: z.number(), pointerId: z.number() }),
  /** The one place the component resets the machine outside the reducer. */
  z.strictObject({ kind: z.literal('reset'), at: z.number(), reason: z.string() }),
])

export type TraceEntry = z.infer<typeof traceEntrySchema>

const gestureTraceSchema = z.strictObject({
  format: z.literal(GESTURE_TRACE_FORMAT),
  recordedAt: z.string(),
  bundle: z.string(),
  userAgent: z.string(),
  viewport: z.strictObject({ width: z.number(), height: z.number(), dpr: z.number() }).optional(),
  entries: z.array(traceEntrySchema).readonly(),
})

type SerializedGestureTrace = z.infer<typeof gestureTraceSchema>

/**
 * Reads a pasted trace for replay, or throws saying why it cannot. A trace
 * from another format is refused rather than coerced: folding the reducer
 * over events whose fields moved answers modes computed from `undefined`,
 * which reads like a reproduction and is not one.
 */
export function parseGestureTrace(text: string): SerializedGestureTrace {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error('Not a gesture trace: the text is not JSON.')
  }
  const format = typeof json === 'object' && json !== null ? Reflect.get(json, 'format') : undefined
  if (format === undefined) {
    throw new Error(
      `Not a gesture trace this build can read: it has no \`format\` field (expected format ${GESTURE_TRACE_FORMAT}).`,
    )
  }
  if (format !== GESTURE_TRACE_FORMAT) {
    throw new Error(
      `Gesture trace format ${String(format)} cannot be replayed by this build, which reads format ${GESTURE_TRACE_FORMAT}.`,
    )
  }
  const parsed = gestureTraceSchema.safeParse(json)
  if (!parsed.success) {
    throw new Error(
      `Gesture trace does not match format ${GESTURE_TRACE_FORMAT}:\n${z.prettifyError(parsed.error)}`,
    )
  }
  return parsed.data
}

interface RecordedNavigation {
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

function serializeGestureTrace(entries: readonly TraceEntry[]): string {
  const trace: SerializedGestureTrace = {
    format: GESTURE_TRACE_FORMAT,
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
    entries,
  }
  return JSON.stringify(trace)
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
      return serializeGestureTrace(ring)
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
        overlay.getAttribute('role') ??
        overlay.tagName.toLowerCase())
  const carrier = target.closest('[data-testid]')
  return {
    tag: target.tagName.toLowerCase(),
    testId: carrier?.getAttribute('data-testid') ?? undefined,
    role: target.getAttribute('role') ?? undefined,
    overlay: overlayName,
  }
}

/** The flight recorder. One per page on purpose — see the module docstring. */
export const gestureTrace: GestureTrace = createGestureTrace()
