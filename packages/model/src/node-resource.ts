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
 * The exhaustiveness the node-kind union gave is NOT given up. It lives
 * here: `RESOURCE_KINDS` is the closed set, `ResourceKind`
 * is `keyof` it, so a `switch (resourceKind(r))` still narrows to `never` and
 * a table written `satisfies Record<ResourceKind, …>` still fails to compile
 * when the set grows. What changes is that the set is declared in one place
 * that also says what each kind EMITS, instead of being implied by four
 * schema arms.
 */
import { z } from 'zod'

const URI_LIST = 'text/uri-list'

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
  // `location` is a plain string because a file's is a path inside a
  // workspace, which is not a URL. A uri-list's IS one, and the node-kind
  // union checked it (`url: z.string().url()`) — so the check moves here
  // rather than being dropped with the arm that carried it.
  .refine((r) => r.mimeType !== URI_LIST || r.location === undefined || URL.canParse(r.location), {
    error: 'a text/uri-list resource must locate a valid URL',
    path: ['location'],
  })
  // A resource either CARRIES its bytes or POINTS at them; carrying both says
  // two different things about the same node. `RESOURCE_KINDS` resolves such
  // a resource to `text` by lookup order, so nothing failed — the projections
  // did. Found by `codecs.property.test.ts`'s confluence property: JSON
  // Canvas keeps whichever field its node kind has a slot for, so the same
  // document came back a text node one way round and a file node the other.
  // Neither is legitimate, so an unrepresentable state is the fix rather than
  // a tie-break. Carrying NEITHER stays valid — that is a resource this build
  // has no reader for, which OCIF conformance requires keeping.
  .refine((r) => r.content === undefined || r.location === undefined, {
    error: 'a resource carries its content or names a location, never both',
    path: ['location'],
  })

export type NodeResource = z.infer<typeof nodeResourceSchema>

/**
 * The most characters (UTF-16 code units) a link's URL, a file's path, or a
 * file's subpath may carry when it is written.
 *
 * Each is drawn as the node's label on every render of its board, at the
 * label's per-character cost. Measured through the real store and the export
 * measurer (`mcp-server/scripts/measure/label-and-comment-cost.mjs`, 4-core
 * machine), one wb_scene_render of a board with one link or file node: 2 Ki
 * ~50-75 ms, 8 Ki ~130 ms, 16 Ki ~230 ms, 64 Ki ~0.9 s, linear at about
 * 14 µs a character past the board's baseline — so a 1 Mi URL costs ~14 s of
 * CPU on every render. 8 Ki rather than a label's 1 Ki because a URL is not
 * chrome someone chose to write: signed and query-heavy URLs legitimately
 * reach a few Ki, and RFC 9110 §4.1 asks every recipient to support at least
 * 8000 octets. A file's path and subpath share the bound so a node's label
 * has one ceiling whatever it points at.
 */
export const NODE_LOCATION_MAX_CHARS = 8 * 1024

/** The location bound as every refusal of it ends, as `NODE_TEXT_LIMIT_PHRASE` is for a node's text. */
export const NODE_LOCATION_LIMIT_PHRASE = `the ${NODE_LOCATION_MAX_CHARS}-character limit`

const tooLong = (what: string) => `${what} is longer than ${NODE_LOCATION_LIMIT_PHRASE}`

/**
 * A link's URL, a file's path and a file's subpath as a tool or route accepts
 * them. The STORED resource stays unbounded: one written before the limit
 * must still read, and still take an edit that leaves it alone.
 */
export const nodeUrlInputSchema = z.url().max(NODE_LOCATION_MAX_CHARS, tooLong("a link's URL"))
export const nodeFileInputSchema = z.string().max(NODE_LOCATION_MAX_CHARS, tooLong("a file's path"))
export const nodeSubpathInputSchema = z
  .string()
  .startsWith('#')
  .max(NODE_LOCATION_MAX_CHARS, tooLong("a file's subpath"))

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
