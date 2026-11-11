import type { FacetTarget } from '@kamiazya/whiteboard-facet-engine'
import type { ExtensionFacets } from '@kamiazya/whiteboard-model'

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

/**
 * A stencil of a workspace's stored library the registry would drop. The
 * core says why: a name that is no facet segment, a registry holding no
 * stencil shape, a stencil that is not one (its issues), or a facet payload it
 * carries (the key, and whether the facet is unregistered, not current or
 * refuses the payload).
 */
export interface DroppedStencil {
  readonly name: string
  readonly why?: 'name' | 'no-shape' | 'shape' | 'facet'
  readonly key?: string
  readonly facet?: 'unregistered' | 'not-current' | 'invalid'
  readonly current?: string
  readonly issues?: readonly FacetWriteIssue[]
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
  // The core says why a stencil is dropped in fields of its own.
  | { readonly stage: 'library'; readonly dropped: readonly DroppedStencil[] }

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
 * shim: a realm's composition root holds both and hands one to the other.
 *
 * It may throw to DECLINE (an error named `CoreInputRefused`, for a call past
 * its caps or a value the wire does not carry). No other implementation
 * answers in its place: a decline is a refusal of the write, by name.
 */
interface FacetWriteCore {
  facetBucketCheck(
    target: FacetTarget,
    bucket: ExtensionFacets | undefined,
    library: Readonly<Record<string, unknown>> | undefined,
  ): FacetWriteJudgement
}

/**
 * A facet write was asked for in a realm that never installed the core. There
 * is no other implementation to answer with, so this is a wiring defect of the
 * realm, never an input to handle.
 */
class FacetWriteCoreNotInstalled extends Error {
  constructor() {
    super(
      'a facet write was asked for before this realm installed the Rust core; call installFacetWriteCore with a loaded core first',
    )
    this.name = 'FacetWriteCoreNotInstalled'
  }
}

/**
 * The core this realm judges facet writes with, or none. Process-global for
 * the reason codec's cores are: a realm loads the wasm asynchronously once, and
 * the writers that ask are reached through `ServerDeps` without a handle on it.
 */
let installed: FacetWriteCore | undefined

/**
 * Makes `core` judge this realm's facet writes; `undefined` removes it.
 * Answers the core it replaced.
 */
export function installFacetWriteCore(
  core: FacetWriteCore | undefined,
): FacetWriteCore | undefined {
  const previous = installed
  installed = core
  return previous
}

/** Whether this realm has a core to judge with. */
export const facetWriteCoreInstalled = (): boolean => installed !== undefined

/** The realm's core, or the named failure for a realm that installed none. */
export function facetWriteCore(): FacetWriteCore {
  if (installed === undefined) throw new FacetWriteCoreNotInstalled()
  return installed
}
