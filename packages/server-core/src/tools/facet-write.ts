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
  composeWorkspaceStencils,
  describeUnrecognizedKey,
  type FacetRegistry,
  type FacetTarget,
  firstUnrecognizedKey,
} from '@kamiazya/whiteboard-facet-engine'
import { ReservedKeyWriteError } from '@kamiazya/whiteboard-loro-adapter'
import { type ExtensionFacets, holdsReservedKey } from '@kamiazya/whiteboard-model'
import { VISUAL_STENCILS_KEY } from '@kamiazya/whiteboard-plugin-visual'
import type { z } from 'zod'
import {
  canonicalJudgement,
  type FacetWriteCore,
  type FacetWriteIssue,
  type FacetWriteJudgement,
  type FacetWriteRefusal,
} from '../facet-write-core.js'
import type { ServerDeps } from '../server-deps.js'
import { FacetWriteRejectedError } from './errors.js'
import {
  refuseUnusableStencilLibrary,
  unusableStencils,
  workspaceStencilLibrary,
} from './stencil-library.js'

/** "an edge", "a node" — the refusal names the object, so it has to read like one. */
function article(target: FacetTarget): string {
  return target === 'edge' ? 'an' : 'a'
}

type Registry = Pick<FacetRegistry, 'targetsOf' | 'validateFacetWrite'>

/** A judgement as the TypeScript words it: a refusal carries its sentence. */
type Judged =
  | Extract<FacetWriteJudgement, { ok: true }>
  | (Extract<FacetWriteJudgement, { ok: false }> & { readonly message: string })

type Refused = Extract<Judged, { ok: false }>

const refusedWith = (key: string, refusal: FacetWriteRefusal, message: string): Refused => ({
  ok: false,
  key,
  refusal,
  message,
})

/** A Zod issue in the shape the core answers, so the two are compared as data. */
function issueOf(issue: z.core.$ZodIssue): FacetWriteIssue {
  const path = issue.path.map((step) => (typeof step === 'number' ? step : String(step)))
  const base = { path, code: issue.code }
  if (issue.code === 'unrecognized_keys') return { ...base, keys: [...issue.keys] }
  if (issue.code === 'invalid_union') return { ...base, arms: issue.errors.map(issuesOf) }
  if (issue.code === 'invalid_key') return { ...base, key: issuesOf(issue.issues) }
  return base
}

const issuesOf = (issues: readonly z.core.$ZodIssue[]): FacetWriteIssue[] => issues.map(issueOf)

/**
 * Judge a bucket without throwing: the validated SETS and DELETIONS, or the
 * first key refused with the stage it was refused at.
 *
 * A registered facet's payload must satisfy its schema, its key must be the
 * current version, and its declared targets must include what this write
 * targets. Unregistered facets pass through unvalidated, for round-trip
 * safety. A registered payload is stored as the schema's PARSED value, and a
 * null payload deletes the key — deletion needs no target or schema check.
 *
 * A payload holding a key named `__proto__` is refused first, naming the
 * facet: an unregistered payload is stored as sent, and the envelope writer's
 * own refusal could only name the container.
 */
function judgeFacetWrites(
  registry: Registry,
  facets: ExtensionFacets | undefined,
  target: FacetTarget,
): Judged {
  const sets: Record<string, unknown> = {}
  const deletions: string[] = []
  for (const [key, payload] of Object.entries(facets ?? {})) {
    if (payload === null) {
      deletions.push(key)
      continue
    }
    const judged = judgePayload(registry, key, payload, target)
    if (!judged.ok) return judged
    sets[key] = judged.value
  }
  return { ok: true, sets, deletions }
}

/** One non-null payload: its parsed value, or the stage it is refused at. */
function judgePayload(
  registry: Registry,
  key: string,
  payload: unknown,
  target: FacetTarget,
): { readonly ok: true; readonly value: unknown } | Refused {
  if (holdsReservedKey(payload)) return refusedWith(key, { stage: 'reserved-key' }, '')
  const targets = registry.targetsOf(key)
  if (targets !== undefined && !targets.includes(target)) {
    return refusedWith(
      key,
      { stage: 'target', targets },
      `its targets are [${targets.join(', ')}], and this write targets ${article(target)} ${target}`,
    )
  }
  const result = registry.validateFacetWrite(key, payload)
  if (!result.ok) {
    const { refusal } = result
    return refusedWith(
      key,
      refusal.stage === 'invalid'
        ? { stage: 'invalid', issues: issuesOf(refusal.issues) }
        : refusal,
      result.message,
    )
  }
  // The registry answers the PARSED value, which is a payload with any key
  // the schema does not declare stripped — right for the editor's derived
  // form, wrong for a caller who would read success as "stored as I sent
  // it": a misspelt `routing` came back as an empty bucket and an applied
  // write.
  const stray = firstUnrecognizedKey(payload, result.value)
  if (stray !== undefined) {
    return refusedWith(
      key,
      { stage: 'unrecognized-key', path: stray.path, key: stray.key },
      `payload for "${key}" is invalid: ${describeUnrecognizedKey(stray)}`,
    )
  }
  return { ok: true, value: result.value }
}

/** The error a refusal stands for: the reserved key's own class, else the facet's. */
function refusalError(refused: Refused): Error {
  return refused.refusal.stage === 'reserved-key'
    ? new ReservedKeyWriteError(`facet "${refused.key}"`)
    : new FacetWriteRejectedError(refused.key, refused.message)
}

function settled(judged: Judged): { sets: Record<string, unknown>; deletions: string[] } {
  if (!judged.ok) throw refusalError(judged)
  return { sets: judged.sets, deletions: [...judged.deletions] }
}

/**
 * Split a bucket into validated SETS and DELETIONS, refusing any payload the
 * registry rejects (see `judgeFacetWrites` for the rules).
 */
export function partitionFacetWrites(
  registry: Registry,
  facets: ExtensionFacets | undefined,
  requiredTarget: FacetTarget,
): { sets: Record<string, unknown>; deletions: string[] } {
  return settled(judgeFacetWrites(registry, facets, requiredTarget))
}

/** `partitionFacetWrites`, then the stencil library the sets carry judged against the deployment. */
function judgeWithLibrary(
  registry: Registry,
  deployment: FacetRegistry,
  facets: ExtensionFacets | undefined,
  target: FacetTarget,
): Judged {
  const judged = judgeFacetWrites(registry, facets, target)
  if (!judged.ok) return judged
  const dropped = unusableStencils(deployment, judged.sets)
  return dropped.length === 0
    ? judged
    : refusedWith(
        VISUAL_STENCILS_KEY,
        { stage: 'library', dropped: dropped.map(({ name }) => ({ name })) },
        dropped.map(({ name, message }) => `stencil "${name}": ${message}`).join('; '),
      )
}

/**
 * What the core's refusal reads as, in words. The core words none (the facet
 * engine's parity declares the sentence a deviation), so this is the
 * TypeScript's own sentence rebuilt from what the stage carries; a schema
 * issue is named by its place and code, not in Zod's words.
 */
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
        .map(
          ({ name, why }) => `stencil "${name}": the registry refused it${why ? ` (${why})` : ''}`,
        )
        .join('; ')
  }
}

const judgedFromCore = (answer: FacetWriteJudgement, target: FacetTarget): Judged =>
  answer.ok ? answer : { ...answer, message: sentenceOf(answer.key, answer.refusal, target) }

/**
 * Where one write is judged, as `facetWriterFor` resolved it: the registry the
 * TypeScript judges through, the deployment's registry the library is judged
 * against, the workspace's stored stencils (read only for a write that names
 * a stencil), and the core.
 */
interface FacetWriteScope {
  readonly registry: FacetRegistry
  readonly deployment: FacetRegistry
  readonly library: Readonly<Record<string, unknown>> | undefined
  readonly core: FacetWriteCore | undefined
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

/**
 * ADR-0054's switch for the facet write: `ts` runs `partitionFacetWrites` and
 * the library refusal; `rust` answers with the core, and `differential` runs
 * both, reports a difference and answers with the TypeScript. A core that
 * throws has declined, and the TypeScript answers in either mode.
 */
function writeWith(
  scope: FacetWriteScope,
  facets: ExtensionFacets | undefined,
  target: FacetTarget,
): { sets: Record<string, unknown>; deletions: string[] } {
  const { core } = scope
  const impl = core?.impl.partitionFacetWrites ?? 'ts'
  const typescript = () => {
    const written = partitionFacetWrites(scope.registry, facets, target)
    refuseUnusableStencilLibrary({ facetRegistry: scope.deployment }, written.sets)
    return written
  }
  if (core === undefined || impl === 'ts') return typescript()
  // The library travels only with a write that names a stencil: it is what
  // the core registers beside the deployment's assets, and no other facet can
  // read it.
  const library = writesAStencilRef(scope.deployment, facets) ? scope.library : undefined
  let rust: Judged
  try {
    rust = judgedFromCore(core.facets.facetBucketCheck(target, facets, library), target)
  } catch (err) {
    core.onMismatch?.({ fn: 'partitionFacetWrites', kind: 'declined', err })
    return typescript()
  }
  if (impl === 'rust') return settled(rust)
  const ts = judgeWithLibrary(scope.registry, scope.deployment, facets, target)
  const [tsValue, rustValue] = [canonicalJudgement(ts), canonicalJudgement(rust)]
  if (tsValue !== rustValue) {
    core.onMismatch?.({
      fn: 'partitionFacetWrites',
      kind: 'differs',
      ts: tsValue,
      rust: rustValue,
      target,
      bucket: facets,
    })
  }
  return settled(ts)
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
  const scope: FacetWriteScope = {
    registry,
    deployment,
    library,
    core: await deps.facetWriteCore?.(),
  }
  return {
    registry,
    write: (facets, target) => writeWith(scope, facets, target),
    checked(facets, target) {
      const { sets } = writeWith(scope, facets, target)
      return Object.keys(sets).length === 0 ? undefined : (sets as ExtensionFacets)
    },
  }
}
