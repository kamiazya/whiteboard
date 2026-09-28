/**
 * The browser keeper's declared capacity (ADR-0044 decision 1): how many
 * documents one browser-kept workspace may hold, and where the promotion band
 * starts.
 *
 * Counted in DOCUMENTS because that is what the cost follows: a workspace
 * record's WASM memory is super-linear in document count, not in content
 * bytes, and the curve is Loro's allocator — Chromium, Firefox and Node agree
 * to 0.1MB (`scripts/measure-workspace-record-memory.mjs`, 2026-09-28):
 *
 *     docs    live     peak (with a full export)
 *      360    65MB     109MB
 *      720   211MB     300MB
 *     1440   751MB     957MB
 *     2880  2809MB    3164MB
 *
 * What differs by device is the CEILING the curve runs into. A desktop tab
 * has wasm32's 4GiB; a phone's OS kills the tab far earlier, often at a few
 * hundred MB, and no browser API reports where. So there are two tiers,
 * judged from what the page can see, and the band is placed where one more
 * full export — which is what moving the workspace away costs — still fits
 * (the ADR's 2026-09-22 criterion):
 *
 * - desktop: band at 1400 (~950MB peak, an export's room to spare under
 *   4GiB); limit at 2000, short of 2880, whose 3.2GB peak leaves no room for
 *   the move the band asked for.
 * - mobile: band at 300 (~100MB peak); limit at 500 (~200MB), inside the few
 *   hundred MB a phone tolerates.
 *
 * ponytail: two fixed tiers. The phone numbers are an estimate — no phone was
 * measured — and the real failure (an allocation refused, a tab killed)
 * stays the backstop. Measure on devices, or probe the ceiling at runtime,
 * if a tier proves wrong.
 */

export interface KeeperCapacity {
  /** Document count at which the keeper starts offering to move the workspace. */
  readonly bandStartsAt: number
  /** Document count at which adding another is refused. */
  readonly limit: number
}

export const DESKTOP_CAPACITY: KeeperCapacity = { bandStartsAt: 1400, limit: 2000 }
export const MOBILE_CAPACITY: KeeperCapacity = { bandStartsAt: 300, limit: 500 }

export type CapacityState = 'room' | 'band' | 'full'

export function capacityState(documentCount: number, capacity: KeeperCapacity): CapacityState {
  if (documentCount >= capacity.limit) return 'full'
  if (documentCount >= capacity.bandStartsAt) return 'band'
  return 'room'
}

interface DeviceSignals {
  /** The primary pointer is a finger — the page's best sign of a phone or tablet. */
  coarsePointer: boolean
  /** `navigator.deviceMemory`: Chromium only, rounded and capped at 8. */
  deviceMemoryGb: number | undefined
}

function readDeviceSignals(): DeviceSignals {
  return {
    coarsePointer: globalThis.matchMedia?.('(pointer: coarse)').matches ?? false,
    deviceMemoryGb: (globalThis.navigator as { deviceMemory?: number } | undefined)?.deviceMemory,
  }
}

export function browserKeeperCapacity(
  signals: DeviceSignals = readDeviceSignals(),
): KeeperCapacity {
  const littleMemory = signals.deviceMemoryGb !== undefined && signals.deviceMemoryGb <= 4
  return signals.coarsePointer || littleMemory ? MOBILE_CAPACITY : DESKTOP_CAPACITY
}

/** Refused at the limit, with what the person can do (ADR-0044 decision 2). */
export class WorkspaceCapacityReachedError extends Error {
  constructor(readonly limit: number) {
    super(
      `This workspace holds ${limit} documents, as many as this browser can keep. ` +
        'Move it to the whiteboard daemon or another keeper from Settings > Connections to add more.',
    )
    this.name = 'WorkspaceCapacityReachedError'
  }
}
