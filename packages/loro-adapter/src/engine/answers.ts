/**
 * How a CRDT answer is written down: plain JSON that keeps what JSON drops,
 * and versions as `[peer, counter]` pairs. The engine's reads answer in this
 * form and the recorded oracles hold it, so one definition serves both.
 *
 * A reader's refusal is part of its answer: an error is recorded as its class,
 * because the Rust engine has to refuse the same rows, and a message is the one
 * thing a port words differently.
 */
import { type Frontiers, LoroDoc, VersionVector } from 'loro-crdt'

export type Answer = { ok: unknown } | { err: string }

/** `[peer, counter]` pairs, peers as decimal strings: JSON has no bigint. */
export type VersionPairs = Array<[string, number]>

/** Peers are u64 decimal strings, so they compare as numbers, not as text. */
function comparePeers(a: string, b: string): number {
  // Only the sign is read, and a nonzero difference never rounds to zero.
  return Number(BigInt(a) - BigInt(b))
}

export function versionPairs(version: VersionVector): VersionPairs {
  return [...version.toJSON().entries()]
    .map(([peer, counter]) => [String(peer), counter] as [string, number])
    .sort(([a], [b]) => comparePeers(a, b))
}

export function versionOfPairs(pairs: VersionPairs): VersionVector {
  return new VersionVector(new Map(pairs.map(([peer, counter]) => [peer as `${number}`, counter])))
}

export function frontierPairs(frontiers: Frontiers): Array<[string, number]> {
  return frontiers
    .map(({ peer, counter }) => [String(peer), counter] as [string, number])
    .sort(([a, x], [b, y]) => comparePeers(a, b) || x - y)
}

/** A tree id is `counter@peer`; the peer of a replica made on the way is random. */
function maskPeers(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(/^(\d+)@\d+$/, '$1@*')
  if (Array.isArray(value)) return value.map(maskPeers)
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskPeers(v)]))
  }
  return value
}

/**
 * JSON that keeps what JSON drops, so two answers that differ only in an
 * `undefined`, a `NaN`, a `Set` or a `Map` do not read as equal.
 */
function plain(value: unknown): unknown {
  if (value === undefined) return { $undefined: true }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : { $number: String(value) }
  if (typeof value === 'bigint') return { $bigint: String(value) }
  // Exported Loro bytes embed the exporting replica's random peer id, so two
  // honest runs differ; what they MEAN is the state they import to.
  if (value instanceof Uint8Array) {
    const held = new LoroDoc()
    held.import(value)
    return { $loroState: maskPeers(held.toJSON()) }
  }
  if (value instanceof Set) return { $set: [...value].map(plain) }
  if (value instanceof Map) return { $map: [...value].map(([k, v]) => [plain(k), plain(v)]) }
  if (Array.isArray(value)) return value.map(plain)
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, plain(v)]),
    )
  }
  return { $unrepresentable: typeof value }
}

/**
 * What `plain` wrote, as the value it described. A reader's own consumer takes
 * the answer back through here so an `undefined`, a non-finite number, a
 * bigint, a `Set` or a `Map` is what the reader produced and not the marker
 * that carried it over the wire. A loro state marker names exported bytes, which
 * an answer cannot carry back, so it is refused.
 */
export function unplain(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(unplain)
  if (typeof value !== 'object' || value === null) return value
  const entries = Object.entries(value)
  const [marker, body] = entries.length === 1 ? (entries[0] ?? []) : []
  const decode =
    marker !== undefined && Object.hasOwn(MARKERS, marker) ? MARKERS[marker] : undefined
  if (decode !== undefined) return decode(body)
  return Object.fromEntries(entries.map(([key, member]) => [key, unplain(member)]))
}

function carriesBytes(marker: string): (body: unknown) => never {
  return () => {
    throw new TypeError(`an answer cannot carry back ${marker}`)
  }
}

/** What each marker `plain` writes stands for. */
const MARKERS: Record<string, ((body: unknown) => unknown) | undefined> = {
  $undefined: () => undefined,
  $number: (body) => Number(body),
  $bigint: (body) => BigInt(String(body)),
  $set: (body) => new Set((body as unknown[]).map(unplain)),
  $map: (body) =>
    new Map((body as Array<[unknown, unknown]>).map(([k, v]) => [unplain(k), unplain(v)])),
  $loroState: carriesBytes('$loroState'),
  $unrepresentable: carriesBytes('$unrepresentable'),
}

const refusal = (error: unknown): Answer => ({
  err: error instanceof Error ? error.constructor.name : typeof error,
})

export function answer(read: () => unknown): Answer {
  try {
    return { ok: plain(read()) }
  } catch (error) {
    return refusal(error)
  }
}

export async function answerLater(read: () => Promise<unknown>): Promise<Answer> {
  try {
    return { ok: plain(await read()) }
  } catch (error) {
    return refusal(error)
  }
}
