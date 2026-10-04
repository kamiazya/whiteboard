/**
 * The one judgement every agent write path asks of a facets bucket: may these
 * registered facets be written HERE (ADR-0013 decisions 6 and 10).
 *
 * `wb_facet_set` was the only caller for a long time, so a node, an edge, a
 * line or a document's frontmatter written through any other tool stored a
 * payload `wb_facet_set` refuses for the same facet. The check lives in one
 * module so a writer cannot disagree with another about what a registered
 * facet accepts, and the refusal reads the same whichever tool carried it.
 */
import {
  describeUnrecognizedKey,
  type FacetRegistry,
  type FacetTarget,
  firstUnrecognizedKey,
} from '@kamiazya/whiteboard-facet-engine'
import type { ExtensionFacets } from '@kamiazya/whiteboard-model'
import type { ServerDeps } from '../server-deps.js'
import { FacetWriteRejectedError } from './errors.js'
import { workspaceFacetRegistry } from './stencil-library.js'

/** "an edge", "a node" — the refusal names the object, so it has to read like one. */
function article(target: FacetTarget): string {
  return target === 'edge' ? 'an' : 'a'
}

/**
 * Split a bucket into validated SETS and DELETIONS, refusing any payload the
 * registry rejects.
 *
 * A registered facet's payload must satisfy its schema, its key must be the
 * current version, and its declared targets must include what this write
 * targets. Unregistered facets pass through unvalidated, for round-trip
 * safety. A registered payload is stored as the schema's PARSED value, and a
 * null payload deletes the key — deletion needs no target or schema check.
 */
export function partitionFacetWrites(
  registry: Pick<FacetRegistry, 'targetsOf' | 'validateFacetWrite'>,
  facets: ExtensionFacets | undefined,
  requiredTarget: FacetTarget,
): { sets: Record<string, unknown>; deletions: string[] } {
  const sets: Record<string, unknown> = {}
  const deletions: string[] = []
  for (const [key, payload] of Object.entries(facets ?? {})) {
    if (payload === null) {
      deletions.push(key)
      continue
    }
    const targets = registry.targetsOf(key)
    if (targets !== undefined && !targets.includes(requiredTarget)) {
      throw new FacetWriteRejectedError(
        key,
        `its targets are [${targets.join(', ')}], and this write targets ${article(requiredTarget)} ${requiredTarget}`,
      )
    }
    const result = registry.validateFacetWrite(key, payload)
    if (!result.ok) {
      throw new FacetWriteRejectedError(key, result.message)
    }
    // The registry answers the PARSED value, which is a payload with any key
    // the schema does not declare stripped — right for the editor's derived
    // form, wrong for a caller who would read success as "stored as I sent
    // it": a misspelt `routing` came back as an empty bucket and an applied
    // write.
    const stray = firstUnrecognizedKey(payload, result.value)
    if (stray !== undefined) {
      throw new FacetWriteRejectedError(
        key,
        `payload for "${key}" is invalid: ${describeUnrecognizedKey(stray)}`,
      )
    }
    sets[key] = result.value
  }
  return { sets, deletions }
}

/**
 * The registry these buckets are validated against.
 *
 * The WORKSPACE's, not only the deployment's, when a bucket writes a facet
 * that takes a stencil: a stencil its own library defines must be writable
 * through every path that dresses a box, or two paths disagree about what a
 * registered id is.
 *
 * Resolved only for such a write. A library can add nothing but stencil
 * assets, so every other write — a tag, a deletion, a shape — gets an
 * identical answer from the deployment's registry and must not pay a document
 * listing for it. Which facets take a stencil is asked OF the registry rather
 * than hardcoded as `visual.stencil/v0`: that is a plugin's declaration, and a
 * server spelling one plugin's key is a server no other plugin extends.
 */
export async function registryForFacetWrites(
  deps: ServerDeps,
  workspaceId: string,
  buckets: readonly (ExtensionFacets | undefined)[],
): Promise<FacetRegistry> {
  const deployment = deps.facetRegistry
  const writesAStencilRef = buckets.some((bucket) =>
    Object.entries(bucket ?? {}).some(
      ([key, payload]) =>
        payload !== null && Object.values(deployment.assetRefsOf(key) ?? {}).includes('stencils'),
    ),
  )
  return writesAStencilRef
    ? await workspaceFacetRegistry(deps, workspaceId, 'deployment')
    : deployment
}

/**
 * A bucket as it is stored once validated: the parsed payloads, with a null
 * (an input-only tombstone) gone and an empty bucket reduced to no bucket, the
 * canonical emptiness every facets writer keeps.
 */
export function checkedBucket(
  registry: Pick<FacetRegistry, 'targetsOf' | 'validateFacetWrite'>,
  facets: ExtensionFacets,
  target: FacetTarget,
): ExtensionFacets | undefined {
  const { sets } = partitionFacetWrites(registry, facets, target)
  return Object.keys(sets).length === 0 ? undefined : sets
}
