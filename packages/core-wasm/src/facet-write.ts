import { type ExtensionFacets, holdsReservedKey } from '@kamiazya/whiteboard-model'
import { FACET_BUCKET_CHECK_CAPS, type RefusalCode } from './generated/input-caps.js'
import { decodeValue, isWellFormed, wireOf } from './value-wire.js'

// A facets bucket judged for a write over the wasm artifact
// (`crates/bindings/wasm/src/facet_write.rs`): the server's
// `partitionFacetWrites` and the stencil library's refusal in one call.
//
// The refusal carries WHERE and WHY, in the stage the TypeScript refuses at
// and the path and code of each schema issue, in order; the sentence is the
// caller's to word. Zod's own text is not reproduced, which is the declared
// deviation of the facet engine's parity (owner decision q43).

/** What a write targets; a facet declares where it may attach. */
export type FacetWriteTarget = 'document' | 'canvas' | 'node' | 'edge'

/** The Zod issue codes a facet's contract can raise. */
export type FacetIssueCode =
  | 'invalid_type'
  | 'too_small'
  | 'too_big'
  | 'invalid_format'
  | 'invalid_value'
  | 'unrecognized_keys'
  | 'invalid_union'
  | 'invalid_key'
  | 'custom'

/**
 * One place a payload was refused: where and why. A union carries why each of
 * its arms refused, and a record's refused key carries the issues of the key.
 */
export interface FacetIssue {
  readonly path: readonly (string | number)[]
  readonly code: FacetIssueCode
  readonly keys?: readonly string[]
  readonly arms?: readonly (readonly FacetIssue[])[]
  readonly key?: readonly FacetIssue[]
}

/** A stored-library stencil the registry would drop, and why. */
export type DroppedStencil = { readonly name: string } & (
  | { readonly why: 'name' | 'no-shape' }
  | { readonly why: 'shape'; readonly issues: readonly FacetIssue[] }
  | {
      readonly why: 'facet'
      readonly key: string
      readonly facet: 'unregistered' | 'not-current' | 'invalid'
      readonly current?: string
      readonly issues?: readonly FacetIssue[]
    }
)

/** The stage a key of a bucket was refused at, with what the stage says. */
export type FacetRefusal =
  | { readonly stage: 'reserved-key' }
  | { readonly stage: 'target'; readonly targets: readonly string[] }
  | { readonly stage: 'malformed-key' }
  | { readonly stage: 'not-current'; readonly current: string }
  | { readonly stage: 'invalid'; readonly issues: readonly FacetIssue[] }
  | {
      readonly stage: 'unregistered-asset'
      readonly field: string
      readonly id: string
      readonly kind: 'themes' | 'icons' | 'stencils'
      readonly registered: readonly string[]
    }
  | {
      readonly stage: 'unrecognized-key'
      readonly path: readonly string[]
      readonly key: string
    }
  | { readonly stage: 'library'; readonly dropped: readonly DroppedStencil[] }

/** `partitionFacetWrites` and the library's refusal: the writes, or the first key refused. */
export type FacetBucketResult =
  | {
      readonly ok: true
      readonly sets: Record<string, unknown>
      readonly deletions: string[]
    }
  | { readonly ok: false; readonly key: string; readonly refusal: FacetRefusal }

/** The errors this module throws, made by the package entry that owns their classes. */
export interface FacetErrors {
  refused(operation: string, code: RefusalCode, detail?: string): Error
}

/** The glue call this module makes. */
export interface FacetGlue {
  facet_bucket_check(target: string, bucket: string, library: string): string
}

const OPERATION = 'facet_bucket_check'

/**
 * The stencils of a workspace's stored library by bare name, as the server
 * reads them. A contract the core judges, so each stencil is `unknown` here
 * on purpose: the core refuses what is no stencil.
 */
export type StoredStencilLibrary = Readonly<Record<string, unknown>>

const CODES: readonly string[] = [
  'invalid_type',
  'too_small',
  'too_big',
  'invalid_format',
  'invalid_value',
  'unrecognized_keys',
  'invalid_union',
  'invalid_key',
  'custom',
]
const KINDS = ['themes', 'icons', 'stencils'] as const

const isText = (x: unknown): x is string => typeof x === 'string'
const isTexts = (x: unknown): x is string[] => Array.isArray(x) && x.every(isText)
const isList = (x: unknown): x is unknown[] => Array.isArray(x)
const isStep = (x: unknown): x is string | number => isText(x) || typeof x === 'number'

function issuesOf(wire: unknown): FacetIssue[] | undefined {
  if (!isList(wire)) return undefined
  const issues = wire.map(issueOf)
  return issues.includes(undefined) ? undefined : (issues as FacetIssue[])
}

/** What an issue carries after its code: `null`, `["keys", keys]`, `["arms", [issues...]]` or `["key", issues]`. */
function detailOf(detail: unknown): Partial<FacetIssue> | undefined {
  if (detail === null) return {}
  const [tag, body] = isList(detail) && detail.length === 2 ? detail : []
  if (tag === 'keys') return isTexts(body) ? { keys: body } : undefined
  if (tag === 'key') {
    const key = issuesOf(body)
    return key === undefined ? undefined : { key }
  }
  const arms = tag === 'arms' && isList(body) ? body.map(issuesOf) : undefined
  return arms === undefined || arms.includes(undefined)
    ? undefined
    : { arms: arms as FacetIssue[][] }
}

function issueOf(wire: unknown): FacetIssue | undefined {
  const [path, code, detail, ...rest] = isList(wire) ? wire : []
  const known = isText(code) && CODES.includes(code) && rest.length === 0
  if (!isList(path) || !path.every(isStep) || !known) return undefined
  const more = detailOf(detail)
  return more === undefined ? undefined : { path, code: code as FacetIssueCode, ...more }
}

/** A stencil dropped for its facet: `[name, "facet", key, why, ...]`. */
function droppedFacetOf(name: string, parts: unknown[]): DroppedStencil | undefined {
  const [, , key, facet, extra] = parts
  if (!isText(key)) return undefined
  if (facet === 'unregistered' && parts.length === 4) return { name, why: 'facet', key, facet }
  if (facet === 'not-current' && isText(extra) && parts.length === 5) {
    return { name, why: 'facet', key, facet, current: extra }
  }
  const issues = facet === 'invalid' && parts.length === 5 ? issuesOf(extra) : undefined
  return issues === undefined ? undefined : { name, why: 'facet', key, facet: 'invalid', issues }
}

function droppedOf(wire: unknown): DroppedStencil | undefined {
  const parts = isList(wire) ? wire : []
  const [name, why] = parts
  if (!isText(name)) return undefined
  if (why === 'name' || why === 'no-shape') return parts.length === 2 ? { name, why } : undefined
  if (why === 'facet') return droppedFacetOf(name, parts)
  const issues = why === 'shape' && parts.length === 3 ? issuesOf(parts[2]) : undefined
  return issues === undefined ? undefined : { name, why: 'shape', issues }
}

/** What follows a stage on the wire, decoded: one reader per stage. */
const STAGES: Record<string, (detail: unknown[]) => FacetRefusal | undefined> = {
  target: ([targets, ...rest]) =>
    rest.length === 0 && isTexts(targets) ? { stage: 'target', targets } : undefined,
  'malformed-key': (detail) => (detail.length === 0 ? { stage: 'malformed-key' } : undefined),
  'not-current': ([current, ...rest]) =>
    rest.length === 0 && isText(current) ? { stage: 'not-current', current } : undefined,
  invalid: ([wire, ...rest]) => {
    const issues = rest.length === 0 ? issuesOf(wire) : undefined
    return issues === undefined ? undefined : { stage: 'invalid', issues }
  },
  'unregistered-asset': ([field, id, kind, registered, ...rest]) => {
    const found = KINDS.find((k) => k === kind)
    const ok = rest.length === 0 && isText(field) && isText(id) && isTexts(registered)
    return ok && found !== undefined
      ? { stage: 'unregistered-asset', field, id, kind: found, registered }
      : undefined
  },
  'unrecognized-key': ([path, key, ...rest]) =>
    rest.length === 0 && isTexts(path) && isText(key)
      ? { stage: 'unrecognized-key', path, key }
      : undefined,
  library: ([wire, ...rest]) => {
    const dropped = rest.length === 0 && isList(wire) ? wire.map(droppedOf) : []
    return dropped.length === 0 || dropped.includes(undefined)
      ? undefined
      : { stage: 'library', dropped: dropped as DroppedStencil[] }
  },
}

const refusalOf = (stage: string, detail: unknown[]): FacetRefusal | undefined =>
  Object.hasOwn(STAGES, stage) ? STAGES[stage]?.(detail) : undefined

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** What the artifact declined, as the error a root answers from the TypeScript. */
function declinedOf(errors: FacetErrors, answer: unknown[]): Error {
  const [, code, detail] = answer
  const known = code === 'input-too-large' || code === 'malformed'
  return known && isText(detail)
    ? errors.refused(OPERATION, code, detail)
    : errors.refused(OPERATION, 'malformed', 'answer')
}

/**
 * `partitionFacetWrites` and the stencil library's refusal over the artifact,
 * for a write that targets `target`. `library` is the workspace's stored
 * stencils, which the caller reads only for a bucket that writes a stencil
 * and passes `undefined` otherwise.
 *
 * A payload that holds the reserved `__proto__` key stops the bucket there,
 * as the server's own walk is stopped: the keys before it are judged, and the
 * answer is `reserved-key` at it unless one of them is refused first. Throws
 * `CoreInputRefused` for a call the artifact does not answer (past its caps,
 * or a value the wire does not carry, such as an `undefined` where the
 * TypeScript would read an absent key), which a root answers from the
 * TypeScript.
 */
export function facetBucketCheck(
  glue: FacetGlue,
  errors: FacetErrors,
  target: FacetWriteTarget,
  bucket: ExtensionFacets | undefined,
  library: StoredStencilLibrary | undefined,
): FacetBucketResult {
  const entries = Object.entries(bucket ?? {})
  const reservedAt = entries.findIndex(
    ([, payload]) => payload !== null && holdsReservedKey(payload),
  )
  const reserved = reservedAt === -1 ? undefined : (entries[reservedAt]?.[0] as string)
  const stopped = reserved === undefined ? undefined : refused(reserved, { stage: 'reserved-key' })
  const judged = reservedAt === -1 ? entries : entries.slice(0, reservedAt)
  if (judged.length === 0) return stopped ?? { ok: true, sets: {}, deletions: [] }
  const [bucketText, libraryText] = encode(errors, judged, library)
  const answer: unknown = JSON.parse(glue.facet_bucket_check(target, bucketText, libraryText))
  return read(errors, answer, stopped)
}

/** The two texts of the wire, or the refusal the root answers from the TypeScript. */
function encode(
  errors: FacetErrors,
  judged: readonly (readonly [string, unknown])[],
  library: StoredStencilLibrary | undefined,
): [string, string] {
  if (judged.some(([key]) => !isWellFormed(key))) throw errors.refused(OPERATION, 'malformed')
  const bucketWire = wireOf(Object.fromEntries(judged), 0)
  const libraryWire = wireOf({ ...library }, 0)
  if (bucketWire === undefined || libraryWire === undefined) {
    throw errors.refused(OPERATION, 'malformed', 'unwritable')
  }
  const texts: [string, string] = [JSON.stringify(bucketWire), JSON.stringify(libraryWire)]
  if (texts[0].length + texts[1].length > FACET_BUCKET_CHECK_CAPS.maxBytes) {
    throw errors.refused(OPERATION, 'input-too-large')
  }
  return texts
}

/**
 * The result an answer stands for. `stopped` is the refusal of a bucket cut at
 * a reserved key, which stands unless a key before it was refused.
 */
function read(
  errors: FacetErrors,
  answer: unknown,
  stopped: FacetBucketResult | undefined,
): FacetBucketResult {
  const [kind, a, b, ...rest] = isList(answer) ? answer : []
  if (kind === 'declined') throw declinedOf(errors, answer as unknown[])
  if (kind === 'ok' && rest.length === 0) return storedOf(errors, a, b, stopped)
  const refusal = kind === 'refused' && isText(a) && isText(b) ? refusalOf(b, rest) : undefined
  if (refusal === undefined || !isText(a)) throw errors.refused(OPERATION, 'malformed', 'answer')
  // The bucket was cut at the reserved key, so a library refusal is the
  // refusal of keys the server never reached.
  return stopped !== undefined && refusal.stage === 'library' ? stopped : refused(a, refusal)
}

const refused = (key: string, refusal: FacetRefusal): FacetBucketResult => ({
  ok: false,
  key,
  refusal,
})

function storedOf(
  errors: FacetErrors,
  setsWire: unknown,
  deletionsWire: unknown,
  stopped: FacetBucketResult | undefined,
): FacetBucketResult {
  const sets = decodeValue(setsWire)
  const deletions = decodeValue(deletionsWire)
  if (!isRecord(sets) || !isTexts(deletions)) throw errors.refused(OPERATION, 'malformed', 'answer')
  return stopped ?? { ok: true, sets, deletions }
}
