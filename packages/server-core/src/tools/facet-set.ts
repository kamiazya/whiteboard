import type { FacetTarget } from '@kamiazya/whiteboard-facet-engine'
import {
  readCoreFacets,
  readDocumentKind,
  readFacets,
  readSpatialCanvas,
  writeCoreFacets,
  writeFacets,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import {
  type DocumentKind,
  documentIdSchema,
  type ExtensionFacets,
  extensionFacetsSchema,
  nodeIdSchema,
  type SpatialCanvas,
  tagWriteSchema,
  workspaceIdSchema,
} from '@kamiazya/whiteboard-model'
import { bundledFacetRegistry } from '@kamiazya/whiteboard-plugin-visual'
import type { LoroDoc } from 'loro-crdt'
import { z } from 'zod'
import type { ServerDeps } from '../server-deps.js'
import { assertDocumentInWorkspace } from './assert-document-in-workspace.js'
import { loadOrCreateDocument, saveDocumentSnapshot } from './document-io.js'
import {
  DocumentKindMismatchError,
  EdgeNotFoundError,
  FacetWriteRejectedError,
  NodeNotFoundError,
} from './errors.js'
import { workspaceFacetRegistry } from './stencil-library.js'
import { refuseAgainstLibrary, workspaceTagLibrary } from './tag-library.js'

/**
 * `extensionFacetsSchema` already enforces the `{namespace}.{name}/v{n}` key
 * pattern (model's `EXTENSION_FACET_KEY_PATTERN`), so a caller can
 * never use this tool to set a core facet (`type`/`title`/`tags`/`view`) or
 * the raw `facets` root key itself — those don't match the pattern and are
 * rejected at parse time rather than needing a separate namespace guard.
 */
/**
 * A ceiling on one request. Facet payloads are small, so this is not about
 * size; it is about a batch big enough that a caller cannot read what it
 * just did.
 */
const MAX_DOCUMENTS = 50

/**
 * Tags are OKF core frontmatter, and "tag this note" is the thing a caller
 * is usually doing when it reaches for this tool — so the shape is the
 * errand's (add these, drop those, keep the rest), not the storage's (the
 * whole list, replaced). The whole-list shape would make ONE payload over
 * many documents clobber each document's own tags, which is exactly the
 * batch this tool exists for.
 */
const tagsChangeSchema = z
  .object({
    // The scoped-tag grammar (ADR-0040 decision 1) is checked HERE, where a
    // tag is written, and only on `add`: a removal names what is stored, and
    // what is stored may have been written by another tool.
    add: z
      .array(tagWriteSchema)
      .optional()
      .describe('Tags to add; one already present is left where it is.'),
    remove: z.array(z.string().min(1)).optional().describe('Tags to drop, by name.'),
    /**
     * Vocabulary maintenance (ADR-0040 decision 5): a typo recovered, or two
     * spellings merged, across everything the named documents hold. Priced
     * against a tool of its own before landing here — see the ADR.
     */
    rename: z
      .array(
        z
          .object({
            from: z.string().min(1).describe('The tag as it is spelled now.'),
            to: tagWriteSchema.describe('What to call it; an existing tag merges.'),
          })
          .strict(),
      )
      .optional()
      .describe(
        'Rename tags throughout the documents named — their own tags and every node and edge — or, with nodeId / edgeId, on that object alone.',
      ),
  })
  .strict()
  // `tags: {}` would pass every later guard and save an unchanged tag
  // list as a new snapshot — the silent no-op the payload guard exists
  // to refuse, arriving one level down.
  .refine(
    (change) =>
      (change.add?.length ?? 0) + (change.remove?.length ?? 0) + (change.rename?.length ?? 0) > 0,
    { message: 'name at least one tag to add, remove or rename' },
  )

export const facetSetInputSchema = z
  .object({
    workspaceId: workspaceIdSchema.describe('The workspace the documents belong to.'),
    documentIds: z
      .array(documentIdSchema)
      .min(1)
      .max(MAX_DOCUMENTS)
      .describe('The documents to write, all with the same payload.'),
    /**
     * Present: the write targets this NODE of a spatial document (facets
     * land in the node's x-whiteboard facets bucket). Absent: the write
     * targets the documents themselves (markdown only).
     */
    nodeId: nodeIdSchema
      .optional()
      .describe(
        'Write to this node of a spatial document instead of to the document itself. Takes exactly one documentId.',
      ),
    /**
     * Present: the write targets this EDGE of a spatial document (facets
     * land in the edge's own x-whiteboard facets bucket, ADR-0013 decision
     * 5's edge slot). Mutually exclusive with `nodeId` and `target`, for the
     * reason those two are exclusive with each other: a write lands on one
     * object, and two ways of naming it are two chances to disagree.
     */
    edgeId: nodeIdSchema
      .optional()
      .describe(
        'Write to this edge of a spatial document instead of to the document itself. Takes exactly one documentId.',
      ),
    tags: tagsChangeSchema
      .optional()
      .describe(
        'Add and remove tags by name on the documents, on a board, or (with nodeId / edgeId) on one node or edge; every other tag stays. A scoped tag is key:value in lowercase identifiers, e.g. health:failing, and one key may carry several values.',
      ),
    /**
     * Where a write with neither `nodeId` nor `edgeId` lands: the documents
     * themselves (markdown frontmatter; the default), or the CANVAS envelope
     * of a spatial document (`x-whiteboard.facets` — ADR-0013 decision 5's
     * canvas slot, where `visual.theme/v0` and a board-wide `visual.edges/v0`
     * live). Two answers rather than four, because `nodeId` and `edgeId`
     * already say which object, and saying it twice is how the two disagree.
     */
    target: z.enum(['document', 'canvas']).optional(),
    /**
     * ONE payload for every document named, not one per document. "Tag
     * these as reviewed" is the thing a caller is actually doing; two
     * different payloads are two different writes and cost a call each.
     *
     * A null value DELETES that facet; anything else sets it. Deletion is
     * an input-only tombstone — stored buckets never hold null.
     */
    facets: extensionFacetsSchema
      .optional()
      .describe(
        'Extension facets to set, keyed `{namespace}.{name}/v{n}` (wb_facet_list says which are registered). Merged by key: an omitted key keeps its value, null deletes it. Not for tags — those are `tags`.',
      ),
  })
  .strict()
export type FacetSetInput = z.infer<typeof facetSetInputSchema>

export const facetSetOutputSchema = z
  .object({
    updated: z
      .array(
        z
          .object({
            documentId: documentIdSchema,
            facets: extensionFacetsSchema.describe(
              'The extension facets now on the document or node.',
            ),
            tags: z
              .array(z.string())
              .optional()
              .describe(
                'The tags on the document, board, node or edge after the write, when `tags` was given.',
              ),
          })
          .strict(),
      )
      .describe('One entry per document, in the order asked for.'),
  })
  .strict()
export type FacetSetOutput = z.infer<typeof facetSetOutputSchema>

/** Neither `tags` nor `facets`: nothing to write, and a silent no-op would read as done. */
export class FacetSetNeedsPayloadError extends Error {
  constructor() {
    super('Nothing to set: pass `tags` (add/remove tags) or `facets` (extension facets), or both.')
    this.name = 'FacetSetNeedsPayloadError'
  }
}

/** A markdown document that has no frontmatter yet has nowhere to put a tag. */
export class DocumentHasNoFrontmatterError extends Error {
  constructor(documentId: string) {
    super(
      `Document ${documentId} has no OKF frontmatter to tag. Write its content first with wb_workspace_edit's document.set op (a markdown body starting with a --- frontmatter block), then tag it.`,
    )
    this.name = 'DocumentHasNoFrontmatterError'
  }
}

/**
 * `nodeId` narrows to a node INSIDE one document, and two documents do not
 * share a node id space — so "this node of these five documents" names
 * nothing. Refused rather than applied to whichever documents happen to
 * have a node by that name.
 *
 * Checked here rather than as a schema `.refine`: refining makes the input
 * a ZodEffects, which has no `.shape`, and the MCP registration hands
 * `.shape` to the SDK to build the tool's published JSON Schema.
 */
export class NodeTargetNeedsOneDocumentError extends Error {
  constructor(count: number) {
    super(
      `nodeId names a node of ONE document, and ${count} documentIds were given. ` +
        'Node ids are scoped to their own document, so the same nodeId in two documents ' +
        'is two unrelated nodes. Call once per document.',
    )
    this.name = 'NodeTargetNeedsOneDocumentError'
  }
}

/**
 * `nodeId` names a node and `target: 'canvas'` names the canvas around it;
 * a write cannot land on both. Refused, like the batch case above and for
 * the same reason it is not a schema `.refine`.
 */
export class NodeAndEdgeTargetError extends Error {
  constructor() {
    super('nodeId targets a node and edgeId targets an edge; pass one or the other.')
    this.name = 'NodeAndEdgeTargetError'
  }
}

/**
 * `nodeId` names a node and `target: 'canvas'` names the canvas around it;
 * a write cannot land on both. Refused, like the batch case above and for
 * the same reason it is not a schema `.refine`.
 */
export class NodeAndCanvasTargetError extends Error {
  constructor() {
    super(
      "nodeId targets one node and target: 'canvas' targets the canvas envelope; pass one or the other.",
    )
    this.name = 'NodeAndCanvasTargetError'
  }
}

/** "an edge", "a node" — the refusal names the object, so it has to read like one. */
function article(target: FacetTarget): string {
  return target === 'edge' ? 'an' : 'a'
}

export function createFacetSetTool(deps: ServerDeps) {
  return {
    name: 'wb_facet_set' as const,
    description:
      "Tag documents, boards, nodes and edges, or set facets on them. `tags` adds and removes tags by name — on one or more markdown documents (OKF core tags), on a spatial document's board, or with nodeId / edgeId on one node or one edge — leaving the other tags alone. `facets` sets extension facets (keys like `visual.shape/v0`; wb_facet_list says which are registered) on the documents, on a spatial document's canvas (target: 'canvas' — where visual.theme/v0 chooses a theme and visual.edges/v0 routes every edge), or — with nodeId or edgeId — on one node or one edge of a spatial document, merging by key: an omitted key keeps its stored value, null deletes it. Registered facets are validated against their schema, their declared targets, and the assets they name. A workspace's tag library (the document at `tags`; wb_facet_list shows it) may restrict a key's values or make it one value at a time, and a tag outside it is refused before anything is written. One payload covers every document named, so tagging five notes is one call.",
    inputSchema: facetSetInputSchema,
    outputSchema: facetSetOutputSchema,
    execute: async (input: FacetSetInput): Promise<FacetSetOutput> => {
      refuseIncoherentRequest(input)
      const registry = await resolveWriteRegistry(deps, input)
      const { sets, deletions } = partitionFacetWrites(registry, input, requiredTargetOf(input))
      await refuseBeforeAnyWrite(deps, input)

      const updated: FacetSetOutput['updated'] = []
      for (const documentId of input.documentIds) {
        updated.push(await setOne(deps, input, documentId, sets, deletions))
      }
      return { updated }
    },
  }
}

/**
 * This tool refuses in PHASES, and the order is the contract: everything that
 * can refuse the batch runs before the first document is written.
 *
 * Each document is its own Loro doc with its own snapshot and there is no
 * transaction across them, so a refusal discovered while writing leaves a
 * PREFIX of the batch applied — and the caller reading that error has no way
 * to learn which documents it got. The phases below are each a refusal, and
 * `execute` is the sequence; a new check belongs in one of them rather than
 * beside the write loop.
 *
 * `facet-set.test.ts` pins it: deleting the document-existence pre-pass fails
 * two cases that assert nothing was written.
 */

/**
 * Which SITE a write targets: an element on the board, the board's own
 * envelope, or the document's frontmatter.
 *
 * One answer, read by both the write (`setOne`) and its dry run
 * (`tagSetsAfter`). They used to derive it separately — the same
 * `input.target === 'canvas' || kind === 'spatial'` written twice, with the
 * element check written twice above it — and the dry run decides what the
 * batch REFUSES while the write decides what it stores. Two copies of that
 * decision is a sync obligation nothing enforces, which is the objection this
 * file already records against the node/edge branches it merged earlier.
 *
 * It answers the site alone. What a MISMATCH costs differs by caller and
 * stays with each: the write throws `DocumentKindMismatchError` with a message
 * naming the way out, the dry run has nothing to refuse and returns nothing.
 */
type FacetWriteSite = 'node' | 'edge' | 'canvas' | 'document'

function writeSiteOf(input: FacetSetInput, kind: DocumentKind | undefined): FacetWriteSite {
  if (input.nodeId !== undefined) return 'node'
  if (input.edgeId !== undefined) return 'edge'
  if (input.target === 'canvas' || kind === 'spatial') return 'canvas'
  return 'document'
}

/** Refuse a request whose own shape is incoherent, before anything is read. */
function refuseIncoherentRequest(input: FacetSetInput): void {
  if (input.tags === undefined && input.facets === undefined) {
    throw new FacetSetNeedsPayloadError()
  }
  if (input.nodeId !== undefined && input.edgeId !== undefined) {
    throw new NodeAndEdgeTargetError()
  }
  const element = input.nodeId ?? input.edgeId
  if (element === undefined) return
  if (input.documentIds.length !== 1) {
    throw new NodeTargetNeedsOneDocumentError(input.documentIds.length)
  }
  if (input.target === 'canvas') {
    throw new NodeAndCanvasTargetError()
  }
}

/** What this write targets, which decides whether a facet may be written at all. */
function requiredTargetOf(input: FacetSetInput): FacetTarget {
  if (input.nodeId !== undefined) return 'node'
  if (input.edgeId !== undefined) return 'edge'
  return input.target ?? 'document'
}

/**
 * The registry this batch is validated against.
 *
 * The WORKSPACE's, not only the deployment's, when the batch writes a facet
 * that takes a stencil: a stencil its own library defines must be writable
 * here too, or the two paths that dress a box disagree — `wb_canvas_edit`
 * applying an id this tool refuses is the shape a single composer exists to
 * prevent.
 *
 * Resolved only for such a write. A library can add nothing but stencil
 * assets, so every other write — a tag, a deletion, a shape — gets an
 * identical answer from the deployment's registry and must not pay a document
 * listing for it. Which facets take a stencil is asked OF the registry rather
 * than hardcoded as `visual.stencil/v0`: that is a plugin's declaration, and a
 * server spelling one plugin's key is a server no other plugin extends.
 */
async function resolveWriteRegistry(deps: ServerDeps, input: FacetSetInput) {
  const deploymentRegistry = deps.facetRegistry ?? bundledFacetRegistry
  const writesAStencilRef = Object.entries(input.facets ?? {}).some(
    ([key, payload]) =>
      payload !== null &&
      Object.values(deploymentRegistry.assetRefsOf(key) ?? {}).includes('stencils'),
  )
  return writesAStencilRef
    ? await workspaceFacetRegistry(deps, input.workspaceId, 'deployment')
    : deploymentRegistry
}

/**
 * Split the batch's facets into validated SETS and DELETIONS, refusing any
 * payload the registry rejects (ADR-0013 decision 6).
 *
 * A registered facet's payload must satisfy its schema, its key must be the
 * current version, and its declared targets must include what this write
 * targets. Unregistered facets pass through unvalidated, for round-trip
 * safety. A registered payload is stored as the schema's PARSED value, and a
 * null payload deletes the key — deletion needs no target or schema check.
 *
 * Done once for the whole batch, before any document is opened: the payload is
 * shared, so a rejected facet is rejected for every document and there is
 * nothing to be gained by discovering it on the third one after two were
 * written.
 */
function partitionFacetWrites(
  registry: {
    targetsOf: (key: string) => readonly FacetTarget[] | undefined
    validateFacetWrite: (
      key: string,
      payload: unknown,
    ) => { ok: true; value: unknown } | { ok: false; message: string }
  },
  input: FacetSetInput,
  requiredTarget: FacetTarget,
): { sets: Record<string, unknown>; deletions: string[] } {
  const sets: Record<string, unknown> = {}
  const deletions: string[] = []
  for (const [key, payload] of Object.entries(input.facets ?? {})) {
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
    sets[key] = result.value
  }
  return { sets, deletions }
}

/**
 * The refusals that need the WORKSPACE read: every document is confirmed to be
 * in it, and then what its tag library forbids is refused.
 *
 * The library is read once per batch (a listing plus a read), and only for a
 * batch that writes tags — a facets-only write gets the same answer either way
 * and must not pay for it. With no library the pre-pass costs nothing further:
 * every set passes, so no document is loaded twice.
 */
async function refuseBeforeAnyWrite(deps: ServerDeps, input: FacetSetInput): Promise<void> {
  for (const documentId of input.documentIds) {
    await assertDocumentInWorkspace(deps.documentIndex, input.workspaceId, documentId)
  }
  if (input.tags === undefined) return
  const library = await workspaceTagLibrary(deps, input.workspaceId, 'deployment')
  if (Object.keys(library).length === 0) return
  for (const documentId of input.documentIds) {
    const doc = await loadOrCreateDocument(deps, input.workspaceId, documentId)
    for (const { what, tags } of tagSetsAfter(doc, input, documentId)) {
      refuseAgainstLibrary(library, tags, what)
    }
  }
}

/**
 * What differs between writing facets to a NODE and to an EDGE. Everything
 * else about the two is identical, which the branches this replaced said in
 * prose three times over — "Same order as the node branch, and for the same
 * reason", "The same canonical emptiness the node and canvas branches keep".
 * A comment claiming two blocks agree is a sync obligation nothing enforces:
 * a change to the emptiness rule, or to how a tag change is applied, had to
 * be made twice or the two targets would quietly diverge.
 */
const ELEMENT_TARGETS = {
  node: {
    collection: 'nodes',
    notFound: (documentId: string, id: string) => new NodeNotFoundError(documentId, id),
    mismatch:
      "Node-target facets live on a spatial document's node. Omit nodeId to set facets on a markdown document.",
  },
  edge: {
    collection: 'edges',
    notFound: (documentId: string, id: string) => new EdgeNotFoundError(documentId, id),
    mismatch:
      "Edge-target facets live on a spatial document's edge. Omit edgeId to set facets on a markdown document.",
  },
} as const

/**
 * Writes facets and tags to ONE node or ONE edge of a spatial document.
 *
 * A kind-less document (freshly created, nothing declared) has no canvas, so
 * the element cannot exist — that is reported rather than a kind being
 * fabricated for a mismatch message, which is why the not-found check comes
 * before the kind check.
 */
async function setElementFacets(
  deps: ServerDeps,
  input: FacetSetInput,
  documentId: string,
  doc: LoroDoc,
  kind: ReturnType<typeof readDocumentKind>,
  sets: Record<string, unknown>,
  deletions: readonly string[],
  which: keyof typeof ELEMENT_TARGETS,
): Promise<FacetSetOutput['updated'][number]> {
  const target = ELEMENT_TARGETS[which]
  const id = (which === 'node' ? input.nodeId : input.edgeId) as string
  if (kind === undefined) throw target.notFound(documentId, id)
  if (kind !== 'spatial') throw new DocumentKindMismatchError(documentId, kind, target.mismatch)

  const canvas = readSpatialCanvas(doc)
  const members: readonly { id: string; facets?: ExtensionFacets; tags?: readonly string[] }[] =
    canvas[target.collection]
  const found = members.find((candidate) => candidate.id === id)
  if (found === undefined) throw target.notFound(documentId, id)

  const merged: ExtensionFacets = { ...found.facets, ...sets }
  for (const key of deletions) delete merged[key]
  // Canonical emptiness: an empty bucket disappears rather than being stored
  // as `{}`, so an element that set a facet and cleared it is identical to one
  // that never had it. A node's `embed` is untouched — they are independent
  // fields now, where the format's extension made them two arms of a union and
  // the branch this replaced had to preserve the other one by hand.
  const { facets: _replaced, tags: _tags, ...rest } = found
  const tags = input.tags === undefined ? undefined : applyTagChange(found.tags, input.tags)
  const next = {
    ...rest,
    ...(Object.keys(merged).length === 0 ? {} : { facets: merged }),
    ...withTags(tags ?? found.tags),
  }
  writeSpatialCanvas(doc, {
    ...canvas,
    [target.collection]: members.map((candidate) => (candidate.id === id ? next : candidate)),
  } as SpatialCanvas)
  await saveDocumentSnapshot(deps, input.workspaceId, documentId, doc)
  return { documentId, facets: merged, ...(tags === undefined ? {} : { tags }) }
}

async function setOne(
  deps: ServerDeps,
  input: FacetSetInput,
  documentId: string,
  sets: Record<string, unknown>,
  deletions: readonly string[],
): Promise<FacetSetOutput['updated'][number]> {
  const doc = await loadOrCreateDocument(deps, input.workspaceId, documentId)
  const kind = readDocumentKind(doc)

  const site = writeSiteOf(input, kind)
  if (site === 'node' || site === 'edge') {
    return await setElementFacets(deps, input, documentId, doc, kind, sets, deletions, site)
  }

  // A facet is OKF frontmatter (ADR-0009 decision 3). A JSON Canvas
  // document has nodes and edges and no frontmatter to put one in, so a
  // facet stored on one is metadata no reader of that format can surface
  // — written, kept, and invisible. Its TAGS are another matter: a board is
  // as taggable as a note (ADR-0040 decision 2), and `target` is not needed
  // to say so, since a board's tags are the canvas's.
  //
  // A document with no kind is allowed through and NOT declared: unlike
  // an OKF content write this replaces nothing, so it has neither
  // something to lose nor any evidence to offer about the format.
  // Stated as the KIND rather than the site, which is what it is about: a
  // JSON Canvas document has no frontmatter. (`site === 'canvas'` here would
  // reduce to the same set, and would not narrow `kind` for the error below.)
  if (kind === 'spatial' && input.target !== 'canvas' && input.facets !== undefined) {
    throw new DocumentKindMismatchError(
      documentId,
      kind,
      "Facets are OKF frontmatter, and a JSON Canvas document has none to hold them. Pass target: 'canvas' for canvas-target facets (a theme, edge routing), nodeId for node-target facets, set them on the markdown document this one refers to, or write its content with `wb_workspace_edit`'s `document.set` op.",
    )
  }
  if (site === 'canvas') {
    return await setCanvasFacets(deps, input, documentId, doc, kind, sets, deletions)
  }
  return await setDocumentFacets(deps, input, documentId, doc, sets, deletions)
}

/**
 * Write to the board's own envelope.
 *
 * One writer per SITE, which is what `setElementFacets` beside it already was
 * — the dispatch in `setOne` is now the whole of `setOne`, and each site's
 * rules (what a markdown document cannot hold, how a rename reaches every node
 * and edge, the canonical emptiness a reverted bucket keeps) live with the
 * write they govern rather than in one body that does all three.
 */
async function setCanvasFacets(
  deps: ServerDeps,
  input: FacetSetInput,
  documentId: string,
  doc: LoroDoc,
  kind: ReturnType<typeof readDocumentKind>,
  sets: Record<string, unknown>,
  deletions: readonly string[],
): Promise<FacetSetOutput['updated'][number]> {
  // A markdown document has no canvas envelope; a document with no kind
  // is allowed through and NOT declared, for the reason the document
  // branch below gives — this replaces nothing, so it has neither
  // something to lose nor any evidence to offer about the format.
  if (kind === 'markdown') {
    throw new DocumentKindMismatchError(
      documentId,
      kind,
      "Canvas-target facets live on a spatial document's canvas envelope. Omit target to set facets on a markdown document.",
    )
  }
  const canvas = readSpatialCanvas(doc)
  const merged: ExtensionFacets = { ...canvas.facets, ...sets }
  for (const key of deletions) delete merged[key]
  const tags = input.tags === undefined ? undefined : applyTagChange(canvas.tags, input.tags)
  // A rename reaches every node and edge too: it is vocabulary
  // maintenance over the document, not a write to the board alone.
  const renames = input.tags?.rename ?? []
  const renamed = <T extends { readonly tags?: readonly string[] }>(element: T): T => {
    if (renames.length === 0 || element.tags === undefined) return element
    const { tags: _before, ...rest } = element
    return { ...rest, ...withTags(applyTagChange(element.tags, { rename: renames })) } as T
  }
  // The same canonical emptiness the web editor's `withCanvasFacet` keeps:
  // an empty bucket disappears, so a reverted canvas never carries a
  // redundant field forever. The comments beside it are untouched.
  const { facets: _replaced, tags: _tags, ...canvasRest } = canvas
  writeSpatialCanvas(doc, {
    ...canvasRest,
    nodes: canvas.nodes.map((node) => renamed(node)),
    edges: canvas.edges.map((edge) => renamed(edge)),
    ...(Object.keys(merged).length === 0 ? {} : { facets: merged }),
    ...withTags(tags ?? canvas.tags),
  })
  await saveDocumentSnapshot(deps, input.workspaceId, documentId, doc)
  return { documentId, facets: merged, ...(tags === undefined ? {} : { tags }) }
}

/** Write to the document's OKF frontmatter. */
async function setDocumentFacets(
  deps: ServerDeps,
  input: FacetSetInput,
  documentId: string,
  doc: LoroDoc,
  sets: Record<string, unknown>,
  deletions: readonly string[],
): Promise<FacetSetOutput['updated'][number]> {
  const mergedFacets: ExtensionFacets = { ...readFacets(doc), ...sets }
  for (const key of deletions) delete mergedFacets[key]
  if (input.facets !== undefined) writeFacets(doc, mergedFacets)

  let tags: string[] | undefined
  if (input.tags !== undefined) {
    const core = readCoreFacets(doc)
    if (core === undefined) throw new DocumentHasNoFrontmatterError(documentId)
    tags = applyTagChange(core.tags, input.tags)
    // The whole core bucket goes back, tags included: writeCoreFacets
    // replaces rather than merges, and an omitted `tags` would drop them.
    const { tags: _previous, ...rest } = core
    writeCoreFacets(doc, tags.length === 0 ? rest : { ...rest, tags })
  }

  await saveDocumentSnapshot(deps, input.workspaceId, documentId, doc)

  return { documentId, facets: mergedFacets, ...(tags === undefined ? {} : { tags }) }
}

/**
 * Every tag set a write to `documentId` would leave behind, each named
 * for a refusal — the node's, the edge's, the board's and every node's
 * and edge's a rename reaches, or the note's own. A target the write
 * cannot reach (no such node, the wrong kind) answers nothing here and
 * leaves `setOne` to refuse it by name.
 */
type TagSet = { what: string; tags: string[] }

function tagSetsAfter(doc: LoroDoc, input: FacetSetInput, documentId: string): TagSet[] {
  const change = input.tags
  if (change === undefined) return []
  const kind = readDocumentKind(doc)
  switch (writeSiteOf(input, kind)) {
    case 'node':
    case 'edge':
      return kind === 'spatial' ? tagSetsAtElement(readSpatialCanvas(doc), input, change) : []
    case 'canvas':
      return kind === 'markdown' ? [] : tagSetsAtCanvas(readSpatialCanvas(doc), change)
    case 'document':
      return tagSetsAtDocument(doc, documentId, change)
  }
}

/**
 * The dry run for an element write. One function per SITE, mirroring the
 * writers: the two used to derive the site separately and each carried its own
 * three-way branch, so a change to what a write REACHES had to be made twice
 * or the refusal pass would refuse a different set than the write produced.
 */
function tagSetsAtElement(
  canvas: SpatialCanvas,
  input: FacetSetInput,
  change: NonNullable<FacetSetInput['tags']>,
): TagSet[] {
  const element =
    input.nodeId !== undefined
      ? canvas.nodes.find((node) => node.id === input.nodeId)
      : canvas.edges.find((edge) => edge.id === input.edgeId)
  if (element === undefined) return []
  const what = input.nodeId !== undefined ? `node ${input.nodeId}` : `edge ${input.edgeId}`
  return [{ what, tags: applyTagChange(element.tags, change) }]
}

/**
 * The dry run for a board write. A rename reaches every node and edge too —
 * vocabulary maintenance over the document, not a write to the board alone —
 * which is what `setCanvasFacets` does and therefore what this must refuse for.
 */
function tagSetsAtCanvas(
  canvas: SpatialCanvas,
  change: NonNullable<FacetSetInput['tags']>,
): TagSet[] {
  const sets: TagSet[] = [{ what: 'the board', tags: applyTagChange(canvas.tags, change) }]
  const rename = change.rename ?? []
  if (rename.length === 0) return sets
  for (const node of canvas.nodes) {
    if (node.tags !== undefined) {
      sets.push({ what: `node ${node.id}`, tags: applyTagChange(node.tags, { rename }) })
    }
  }
  for (const edge of canvas.edges) {
    if (edge.tags !== undefined) {
      sets.push({ what: `edge ${edge.id}`, tags: applyTagChange(edge.tags, { rename }) })
    }
  }
  return sets
}

/** The dry run for a frontmatter write. */
function tagSetsAtDocument(
  doc: LoroDoc,
  documentId: string,
  change: NonNullable<FacetSetInput['tags']>,
): TagSet[] {
  const core = readCoreFacets(doc)
  if (core === undefined) return []
  return [{ what: `document ${documentId}`, tags: applyTagChange(core.tags, change) }]
}

/**
 * The errand's shape applied to a stored set: drop what `remove` names,
 * then append what `add` names and the set does not yet hold — a tag added
 * twice is a no-op rather than a second copy (ADR-0040 decision 2).
 */
function applyTagChange(
  current: readonly string[] | undefined,
  change: {
    add?: readonly string[]
    remove?: readonly string[]
    rename?: readonly { from: string; to: string }[]
  },
): string[] {
  // Rename first, then remove, then add — so `rename` onto a tag already
  // present MERGES (one copy survives) and a removal names the new spelling.
  const renamed = (current ?? []).map(
    (tag) => change.rename?.find((r) => r.from === tag)?.to ?? tag,
  )
  const remove = new Set(change.remove ?? [])
  const kept = renamed.filter((tag, i, all) => !remove.has(tag) && all.indexOf(tag) === i)
  const added = (change.add ?? []).filter(
    (tag, i, all) => !kept.includes(tag) && all.indexOf(tag) === i,
  )
  return [...kept, ...added]
}

/** Canonical emptiness for a tag set: an empty list is no field at all. */
function withTags(tags: readonly string[] | undefined): { tags?: string[] } {
  return tags === undefined || tags.length === 0 ? {} : { tags: [...tags] }
}
