/**
 * What a node SHOWS, as OCIF decomposes it: a resource with a media type,
 * carrying its bytes inline or naming where they live
 * ([ADR-0038](../../../docs/contributing/adr/0038-ocif-projection.md)
 * decision 3).
 *
 * The stored shape invents no discriminant. `mimeType` plus `content` or
 * `location` is what OCIF says and what `toOcif` already emits, and a
 * `kind: 'text'` beside them would be a second place the same fact lives —
 * the drift this package exists to prevent, one level down.
 *
 * The exhaustiveness that the node-kind union used to give is NOT given up
 * with it. It moves here: `RESOURCE_KINDS` is the closed set, `ResourceKind`
 * is `keyof` it, so a `switch (resourceKind(r))` still narrows to `never` and
 * a table written `satisfies Record<ResourceKind, …>` still fails to compile
 * when the set grows. What changes is that the set is declared in one place
 * that also says what each kind EMITS, instead of being implied by four
 * schema arms.
 */
import { z } from 'zod'

export const nodeResourceSchema = z
  .object({
    /** The media type of what this node shows. */
    mimeType: z.string().min(1),
    /** The bytes themselves, when the node carries them. */
    content: z.string().optional(),
    /** Where the bytes live, when the node points at them instead. */
    location: z.string().optional(),
    /** A fragment inside the thing at `location`. */
    subpath: z.string().startsWith('#').optional(),
  })
  .strict()

export type NodeResource = z.infer<typeof nodeResourceSchema>

const URI_LIST = 'text/uri-list'

export interface ResourceKindSpec {
  /** What a resource of this kind is emitted with. */
  readonly mimeType: string
  /**
   * Whether this resource is of this kind. The matchers are MUTUALLY
   * EXCLUSIVE by construction — inline content is one kind, a location splits
   * by media type — so resolution is a lookup rather than an ordered chain,
   * and `node-resource.test.ts` holds that as a property rather than a claim.
   */
  readonly matches: (resource: NodeResource) => boolean
}

export const RESOURCE_KINDS = {
  /** Markdown the node carries itself. */
  text: {
    mimeType: 'text/markdown',
    matches: (r) => r.content !== undefined,
  },
  /** An address somewhere else. */
  link: {
    mimeType: URI_LIST,
    matches: (r) => r.content === undefined && r.location !== undefined && r.mimeType === URI_LIST,
  },
  /** Something with a location that is not a bare address — a document, an image. */
  file: {
    mimeType: 'application/octet-stream',
    matches: (r) => r.content === undefined && r.location !== undefined && r.mimeType !== URI_LIST,
  },
} satisfies Record<string, ResourceKindSpec>

export type ResourceKind = keyof typeof RESOURCE_KINDS

/**
 * Which kind this resource is, or `undefined` when nothing in the table
 * claims it.
 *
 * `undefined` is a first-class answer rather than a fallback to text. A
 * document written by another OCIF tool may carry a resource this build has
 * no reader for, and OCIF conformance requires keeping it; under the node-kind
 * union such a node did not degrade, it VANISHED — `spatialNodeSchema` is a
 * discriminated union, so an unknown arm failed to parse and `readSpatialCanvas`
 * drops what fails.
 */
export function resourceKind(resource: NodeResource): ResourceKind | undefined {
  for (const id of Object.keys(RESOURCE_KINDS) as ResourceKind[]) {
    if (RESOURCE_KINDS[id].matches(resource)) return id
  }
  return undefined
}
