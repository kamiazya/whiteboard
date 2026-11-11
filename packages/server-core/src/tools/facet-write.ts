/**
 * The one judgement every agent write path asks of a facets bucket: may these
 * registered facets be written HERE (ADR-0013 decisions 6 and 10).
 *
 * The Rust core judges it (ADR-0054); this module resolves what the core is
 * given (the target, the bucket and the workspace's stored stencil library) and
 * words what it answers. `wb_facet_set` was the only caller for a long time, so
 * a node, an edge, a line or a document's frontmatter written through any other
 * tool stored a payload `wb_facet_set` refuses for the same facet. The check
 * lives in one module so a writer cannot disagree with another about what a
 * registered facet accepts, and the refusal reads the same whichever tool
 * carried it.
 */
import {
  composeWorkspaceStencils,
  describeUnrecognizedKey,
  type FacetRegistry,
  type FacetTarget,
} from '@kamiazya/whiteboard-facet-engine'
import { ReservedKeyWriteError } from '@kamiazya/whiteboard-loro-adapter'
import type { ExtensionFacets } from '@kamiazya/whiteboard-model'
import {
  type DroppedStencil,
  type FacetWriteIssue,
  type FacetWriteJudgement,
  type FacetWriteRefusal,
  facetWriteCore,
} from '../facet-write-core.js'
import type { ServerDeps } from '../server-deps.js'
import { FacetWriteRejectedError } from './errors.js'
import { workspaceStencilLibrary } from './stencil-library.js'

/** "an edge", "a node" — the refusal names the object, so it has to read like one. */
function article(target: FacetTarget): string {
  return target === 'edge' ? 'an' : 'a'
}

/**
 * What the core's refusal reads as, in words. The core words none (the facet
 * engine's parity declares the sentence a deviation), so the sentence is built
 * from what the stage carries; a schema issue is named by its place and code,
 * not in Zod's words.
 */
const issueList = (issues: readonly FacetWriteIssue[] | undefined): string =>
  (issues ?? []).map((issue) => `${issue.path.join('.') || '(payload)'}: ${issue.code}`).join('; ')

/** Why the core would drop a stored stencil, in the words a writer can act on. */
function droppedSentence(dropped: DroppedStencil): string {
  switch (dropped.why) {
    case 'name':
      return 'its name is not a facet segment'
    case 'no-shape':
      return 'the registry holds no stencil shape to judge it by'
    case 'shape':
      return `it is not a stencil: ${issueList(dropped.issues)}`
    case 'facet':
      if (dropped.facet === 'unregistered')
        return `it carries "${dropped.key}", which no plugin registered`
      if (dropped.facet === 'not-current')
        return `it carries "${dropped.key}", which is not the current version — write "${dropped.current}"`
      return `its "${dropped.key}" payload is invalid: ${issueList(dropped.issues)}`
    default:
      return 'the registry refused it'
  }
}

function sentenceOf(key: string, refusal: FacetWriteRefusal, target: FacetTarget): string {
  switch (refusal.stage) {
    case 'reserved-key':
      return ''
    case 'target':
      return `its targets are [${refusal.targets.join(', ')}], and this write targets ${article(target)} ${target}`
    case 'malformed-key':
      return `malformed facet key "${key}"`
    case 'not-current':
      return `"${key}" is not the current version — write "${refusal.current}"`
    case 'invalid':
      return `payload for "${key}" is invalid: ${refusal.issues
        .map((issue) => `${issue.path.join('.') || '(payload)'}: ${issue.code}`)
        .join('; ')}`
    case 'unregistered-asset':
      return `"${key}" field ${refusal.field} names ${refusal.kind} asset "${refusal.id}", which no plugin registered — registered: ${refusal.registered.length === 0 ? '(none)' : refusal.registered.join(', ')}`
    case 'unrecognized-key':
      return `payload for "${key}" is invalid: ${describeUnrecognizedKey(refusal)}`
    case 'library':
      return refusal.dropped
        .map((dropped) => `stencil "${dropped.name}": ${droppedSentence(dropped)}`)
        .join('; ')
  }
}

/** Whether a bucket writes a facet that takes a stencil. */
function writesAStencilRef(
  deployment: FacetRegistry,
  bucket: ExtensionFacets | undefined,
): boolean {
  return Object.entries(bucket ?? {}).some(
    ([key, payload]) =>
      payload !== null && Object.values(deployment.assetRefsOf(key) ?? {}).includes('stencils'),
  )
}

/** The name of the error the shim throws for an input the core will not take. */
const isDecline = (err: unknown): boolean => err instanceof Error && err.name === 'CoreInputRefused'

/**
 * The core's judgement of one bucket as the sets and deletions it stands for,
 * or the error a refusal stands for: the reserved key's own class, else the
 * facet's. A call the core declines (past its caps, or a value its wire does
 * not carry) is refused too, with the core's reason: there is no second
 * implementation to answer it.
 */
function writeWith(
  deployment: FacetRegistry,
  library: Readonly<Record<string, unknown>> | undefined,
  facets: ExtensionFacets | undefined,
  target: FacetTarget,
): { sets: Record<string, unknown>; deletions: string[] } {
  // The library travels only with a write that names a stencil: it is what
  // the core registers beside the deployment's assets, and no other facet can
  // read it.
  const sent = writesAStencilRef(deployment, facets) ? library : undefined
  let judged: FacetWriteJudgement
  try {
    judged = facetWriteCore().facetBucketCheck(target, facets, sent)
  } catch (err) {
    if (!isDecline(err)) throw err
    const [first = '(bucket)'] = Object.keys(facets ?? {})
    throw new FacetWriteRejectedError(
      first,
      `the Rust core declined this write: ${(err as Error).message}`,
    )
  }
  if (judged.ok) return { sets: judged.sets, deletions: [...judged.deletions] }
  if (judged.refusal.stage === 'reserved-key') {
    throw new ReservedKeyWriteError(`facet "${judged.key}"`)
  }
  throw new FacetWriteRejectedError(judged.key, sentenceOf(judged.key, judged.refusal, target))
}

/** What a tool writes facets through, resolved once for the buckets it will write. */
export interface FacetWriter {
  /** The registry stencils resolve through for this write: the workspace's when it names a stencil. */
  readonly registry: FacetRegistry
  /** The validated sets and deletions of a bucket, and the stencil library it carries judged. */
  write(
    facets: ExtensionFacets | undefined,
    target: FacetTarget,
  ): { sets: Record<string, unknown>; deletions: string[] }
  /**
   * A bucket as it is stored once validated: the parsed payloads, with a null
   * (an input-only tombstone) gone and an empty bucket reduced to no bucket,
   * the canonical emptiness every facets writer keeps.
   */
  checked(facets: ExtensionFacets, target: FacetTarget): ExtensionFacets | undefined
}

/**
 * The writer these buckets are validated through.
 *
 * The registry is the WORKSPACE's, not only the deployment's, when a bucket
 * writes a facet that takes a stencil (or the caller says it needs the
 * library anyway): a stencil its own library defines must be writable through
 * every path that dresses a box, or two paths disagree about what a
 * registered id is.
 *
 * Resolved only for such a write. A library can add nothing but stencil
 * assets, so every other write — a tag, a deletion, a shape — gets an
 * identical answer from the deployment's registry and must not pay a document
 * listing for it. Which facets take a stencil is asked OF the registry rather
 * than hardcoded as `visual.stencil/v0`: that is a plugin's declaration, and a
 * server spelling one plugin's key is a server no other plugin extends.
 */
export async function facetWriterFor(
  deps: ServerDeps,
  workspaceId: string,
  buckets: readonly (ExtensionFacets | undefined)[],
  needsLibrary = false,
): Promise<FacetWriter> {
  const deployment = deps.facetRegistry
  const library =
    needsLibrary || buckets.some((bucket) => writesAStencilRef(deployment, bucket))
      ? await workspaceStencilLibrary(deps, workspaceId, 'deployment')
      : undefined
  const registry =
    library === undefined ? deployment : composeWorkspaceStencils(deployment, library).registry
  // Asked at resolution, so a realm without the core fails where it is wired
  // rather than at the first bucket a tool happens to write.
  facetWriteCore()
  return {
    registry,
    write: (facets, target) => writeWith(deployment, library, facets, target),
    checked(facets, target) {
      const { sets } = writeWith(deployment, library, facets, target)
      return Object.keys(sets).length === 0 ? undefined : (sets as ExtensionFacets)
    },
  }
}
