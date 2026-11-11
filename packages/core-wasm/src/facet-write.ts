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

function issuesOf(wire: unknown): FacetIssue[] | undefined {
  if (!isList(wire)) return undefined
  const issues: FacetIssue[] = []
  for (const item of wire) {
    const issue = issueOf(item)
    if (issue === undefined) return undefined
    issues.push(issue)
  }
  return issues
}

function issueOf(wire: unknown): FacetIssue | undefined {
  const [path, code, detail, ...rest] = isList(wire) ? wire : []
  const steps = isList(path) ? path : undefined
  if (steps === undefined || !steps.every((s) => isText(s) || typeof s === 'number')) {
    return undefined
  }
  if (!isText(code) || !CODES.includes(code) || rest.length > 0) return undefined
  const base = { path: steps as (string | number)[], code: code as FacetIssueCode }
  if (detail === null) return base
  const [tag, body] = isList(detail) && detail.length === 2 ? detail : []
  if (tag === 'keys' && isTexts(body)) return { ...base, keys: body }
  if (tag === 'key') {
    const key = issuesOf(body)
    return key === undefined ? undefined : { ...base, key }
  }
  if (tag !== 'arms' || !isList(body)) return undefined
  const arms = body.map(issuesOf)
  return arms.includes(undefined) ? undefined : { ...base, arms: arms as FacetIssue[][] }
}

function droppedOf(wire: unknown): DroppedStencil | undefined {
  const parts = isList(wire) ? wire : []
  const [name, why, a, b, c] = parts
  if (!isText(name)) return undefined
  if (why === 'name' || why === 'no-shape') return parts.length === 2 ? { name, why } : undefined
  if (why === 'shape') {
    const issues = issuesOf(a)
    return issues === undefined || parts.length !== 3 ? undefined : { name, why, issues }
  }
  if (why !== 'facet' || !isText(a)) return undefined
  if (b === 'unregistered' && parts.length === 4) return { name, why, key: a, facet: b }
  if (b === 'not-current' && isText(c) && parts.length === 5) {
    return { name, why, key: a, facet: b, current: c }
  }
  const issues = b === 'invalid' && parts.length === 5 ? issuesOf(c) : undefined
  return issues === undefined ? undefined : { name, why, key: a, facet: 'invalid', issues }
}

function refusalOf(stage: unknown, detail: unknown[]): FacetRefusal | undefined {
  const [a, b, c, d] = detail
  switch (stage) {
    case 'target':
      return detail.length === 1 && isTexts(a) ? { stage, targets: a } : undefined
    case 'malformed-key':
      return detail.length === 0 ? { stage } : undefined
    case 'not-current':
      return detail.length === 1 && isText(a) ? { stage, current: a } : undefined
    case 'invalid': {
      const issues = detail.length === 1 ? issuesOf(a) : undefined
      return issues === undefined ? undefined : { stage, issues }
    }
    case 'unregistered-asset': {
      const kind = KINDS.find((k) => k === c)
      const ok = detail.length === 4 && isText(a) && isText(b) && isTexts(d)
      return ok && kind !== undefined ? { stage, field: a, id: b, kind, registered: d } : undefined
    }
    case 'unrecognized-key':
      return detail.length === 2 && isTexts(a) && isText(b) ? { stage, path: a, key: b } : undefined
    case 'library': {
      const dropped = detail.length === 1 && isList(a) ? a.map(droppedOf) : []
      return dropped.length === 0 || dropped.includes(undefined)
        ? undefined
        : { stage, dropped: dropped as DroppedStencil[] }
    }
    default:
      return undefined
  }
}

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
  const judged = reservedAt === -1 ? entries : entries.slice(0, reservedAt)
  const reserved = reservedAt === -1 ? undefined : (entries[reservedAt]?.[0] as string)
  const stopped: FacetBucketResult | undefined =
    reserved === undefined ? undefined : refused(reserved, { stage: 'reserved-key' })
  if (judged.length === 0) return stopped ?? { ok: true, sets: {}, deletions: [] }
  if (judged.some(([key]) => !isWellFormed(key))) throw errors.refused(OPERATION, 'malformed')
  const bucketWire = wireOf(Object.fromEntries(judged), 0)
  const libraryWire = wireOf({ ...library }, 0)
  if (bucketWire === undefined || libraryWire === undefined) {
    throw errors.refused(OPERATION, 'malformed', 'unwritable')
  }
  const [bucketText, libraryText] = [JSON.stringify(bucketWire), JSON.stringify(libraryWire)]
  if (bucketText.length + libraryText.length > FACET_BUCKET_CHECK_CAPS.maxBytes) {
    throw errors.refused(OPERATION, 'input-too-large')
  }
  const answer: unknown = JSON.parse(glue.facet_bucket_check(target, bucketText, libraryText))
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
