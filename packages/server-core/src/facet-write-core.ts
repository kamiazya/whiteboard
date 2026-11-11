import type { FacetTarget } from '@kamiazya/whiteboard-facet-engine'
import type { ExtensionFacets } from '@kamiazya/whiteboard-model'

/**
 * ADR-0054's per-function switch for the facet write: `ts` runs the
 * TypeScript alone; `differential` runs both, reports any difference and
 * answers with the TypeScript; `rust` answers with the core, the TypeScript
 * still present so rollback is flipping this back.
 */
type FacetWriteImpl = 'ts' | 'differential' | 'rust'

/**
 * One place a payload was refused: where and why. A union carries why each of
 * its arms refused, and a record's refused key carries the issues of the key.
 */
export interface FacetWriteIssue {
  readonly path: readonly (string | number)[]
  readonly code: string
  readonly keys?: readonly string[]
  readonly arms?: readonly (readonly FacetWriteIssue[])[]
  readonly key?: readonly FacetWriteIssue[]
}

/** The stage a key of a bucket was refused at, with what the stage says. */
export type FacetWriteRefusal =
  | { readonly stage: 'reserved-key' }
  | { readonly stage: 'target'; readonly targets: readonly string[] }
  | { readonly stage: 'malformed-key' }
  | { readonly stage: 'not-current'; readonly current: string }
  | { readonly stage: 'invalid'; readonly issues: readonly FacetWriteIssue[] }
  | {
      readonly stage: 'unregistered-asset'
      readonly field: string
      readonly id: string
      readonly kind: string
      readonly registered: readonly string[]
    }
  | {
      readonly stage: 'unrecognized-key'
      readonly path: readonly string[]
      readonly key: string
    }
  // Only the names are held equal: the TypeScript names a dropped stencil and
  // words why, the core says why in a type of its own (`why`).
  | {
      readonly stage: 'library'
      readonly dropped: readonly { readonly name: string; readonly why?: string }[]
    }

/** A bucket judged: the writes it stands for, or the first key refused. */
export type FacetWriteJudgement =
  | {
      readonly ok: true
      readonly sets: Record<string, unknown>
      readonly deletions: readonly string[]
    }
  | { readonly ok: false; readonly key: string; readonly refusal: FacetWriteRefusal }

/**
 * The Rust core's facet write, as `@kamiazya/whiteboard-core-wasm`'s `Core`
 * answers it. Declared here, structurally, so this package never imports the
 * shim: the composition root holds both and hands one to the other, and its
 * assignment is where the two are checked against each other.
 *
 * It may throw to DECLINE (the shim's `CoreInputRefused` for a call past its
 * caps, or a value the wire does not carry). A decline is answered by the
 * TypeScript, in every mode.
 */
interface FacetWriteCalls {
  facetBucketCheck(
    target: FacetTarget,
    bucket: ExtensionFacets | undefined,
    library: Readonly<Record<string, unknown>> | undefined,
  ): FacetWriteJudgement
}

/**
 * A difference `differential` mode found, or a call the core declined. The two
 * answers are given whole, each as one canonical string, so the report needs
 * nothing else to be read. The words of a refusal are not compared: the core
 * words none.
 */
export type FacetWriteMismatch =
  | {
      readonly fn: 'partitionFacetWrites'
      readonly kind: 'differs'
      readonly ts: string
      readonly rust: string
      readonly target: FacetTarget
      readonly bucket: ExtensionFacets | undefined
    }
  | { readonly fn: 'partitionFacetWrites'; readonly kind: 'declined'; readonly err: unknown }

/** The core as a caller is handed it: the implementation, the switch, where a report goes. */
export interface FacetWriteCore {
  readonly facets: FacetWriteCalls
  readonly impl: { readonly partitionFacetWrites: FacetWriteImpl }
  readonly onMismatch?: (mismatch: FacetWriteMismatch) => void
}

const bits = new DataView(new ArrayBuffer(8))

/**
 * A value as plain JSON that tells apart everything one can hold: a number by
 * its 64 bits (so `-0` is not `0`), a key holding `undefined` from an absent
 * one, a list from an object, and an object's keys in the order JavaScript
 * enumerates them.
 */
function canonicalValue(value: unknown): unknown {
  if (typeof value === 'number') {
    bits.setFloat64(0, value)
    return ['f', bits.getBigUint64(0).toString(16)]
  }
  if (value === undefined) return ['u']
  if (Array.isArray(value)) return ['s', ...value.map(canonicalValue)]
  if (typeof value === 'object' && value !== null) {
    return ['m', ...Object.entries(value).flatMap(([k, v]) => [k, canonicalValue(v)])]
  }
  return value
}

const canonicalIssues = (issues: readonly FacetWriteIssue[]): unknown[] =>
  issues.map((issue) => [
    issue.path.map(String),
    issue.code,
    issue.keys ?? null,
    issue.arms?.map(canonicalIssues) ?? null,
    issue.key === undefined ? null : canonicalIssues(issue.key),
  ])

function canonicalRefusal(refusal: FacetWriteRefusal): unknown {
  switch (refusal.stage) {
    case 'target':
      return [refusal.stage, refusal.targets]
    case 'not-current':
      return [refusal.stage, refusal.current]
    case 'invalid':
      return [refusal.stage, canonicalIssues(refusal.issues)]
    case 'unregistered-asset':
      return [refusal.stage, refusal.field, refusal.id, refusal.kind, refusal.registered]
    case 'unrecognized-key':
      return [refusal.stage, refusal.path, refusal.key]
    case 'library':
      return [refusal.stage, refusal.dropped.map((entry) => entry.name)]
    default:
      return [refusal.stage]
  }
}

/**
 * What two judgements are held equal on: the refusal's key, stage, and what
 * the stage carries (every issue's path and code in order, with the keys,
 * arms and key issues under it), or the sets by every number's bits and every
 * key's order and the deletions in order.
 */
export function canonicalJudgement(judgement: FacetWriteJudgement): string {
  return JSON.stringify(
    judgement.ok
      ? ['ok', canonicalValue(judgement.sets), judgement.deletions]
      : ['refused', judgement.key, canonicalRefusal(judgement.refusal)],
  )
}
