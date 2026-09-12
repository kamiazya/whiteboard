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
  type CanvasEdge,
  documentIdSchema,
  type ExtensionFacets,
  extensionFacetsSchema,
  nodeIdSchema,
  type SpatialNode,
  workspaceIdSchema,
} from '@kamiazya/whiteboard-model'
import { bundledFacetRegistry } from '@kamiazya/whiteboard-plugin-visual'
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
    add: z
      .array(z.string().min(1))
      .optional()
      .describe('Tags to add; one already present is left where it is.'),
    remove: z.array(z.string().min(1)).optional().describe('Tags to drop, by name.'),
  })
  .strict()
  // `tags: {}` would pass every later guard and save an unchanged tag
  // list as a new snapshot — the silent no-op the payload guard exists
  // to refuse, arriving one level down.
  .refine((change) => (change.add?.length ?? 0) + (change.remove?.length ?? 0) > 0, {
    message: 'name at least one tag to add or remove',
  })

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
        'Set the facets on this node of a spatial document instead of on the document itself. Takes exactly one documentId, and no tags.',
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
        'Set the facets on this edge of a spatial document instead of on the document itself. Takes exactly one documentId, and no tags.',
      ),
    tags: tagsChangeSchema
      .optional()
      .describe(
        "Change the documents' OKF core tags: add and remove by name, every other tag stays. Markdown documents only.",
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
              .describe("The document's tags after the write, when `tags` was given."),
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
    super(
      'Nothing to set: pass `tags` (add/remove OKF core tags) or `facets` (extension facets), or both.',
    )
    this.name = 'FacetSetNeedsPayloadError'
  }
}

/** Tags are a document's frontmatter; a node has none. */
export class TagsTargetDocumentError extends Error {
  constructor() {
    super(
      'Tags are OKF frontmatter and belong to the document, not to a node. Omit nodeId to tag the document, or omit tags to set node facets.',
    )
    this.name = 'TagsTargetDocumentError'
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
      "Tag documents, or set facets on them. `tags` adds and removes OKF core tags by name on one or more markdown documents, leaving the other tags alone. `facets` sets extension facets (keys like `visual.shape/v0`; wb_facet_list says which are registered) on the documents, on a spatial document's canvas (target: 'canvas' — where visual.theme/v0 chooses a theme and visual.edges/v0 routes every edge), or — with nodeId or edgeId — on one node or one edge of a spatial document, merging by key: an omitted key keeps its stored value, null deletes it. Registered facets are validated against their schema, their declared targets, and the assets they name. One payload covers every document named, so tagging five notes is one call.",
    inputSchema: facetSetInputSchema,
    outputSchema: facetSetOutputSchema,
    execute: async (input: FacetSetInput): Promise<FacetSetOutput> => {
      if (input.tags === undefined && input.facets === undefined) {
        throw new FacetSetNeedsPayloadError()
      }
      const element = input.nodeId ?? input.edgeId
      if (input.nodeId !== undefined && input.edgeId !== undefined) {
        throw new NodeAndEdgeTargetError()
      }
      if (element !== undefined && input.tags !== undefined) {
        throw new TagsTargetDocumentError()
      }
      if (element !== undefined && input.documentIds.length !== 1) {
        throw new NodeTargetNeedsOneDocumentError(input.documentIds.length)
      }
      if (element !== undefined && input.target === 'canvas') {
        throw new NodeAndCanvasTargetError()
      }

      // Write-side validation (ADR-0013 decision 6): a REGISTERED facet's
      // payload must satisfy its schema, its key must be the current
      // version, and its declared targets must include what this write
      // targets — 'node' when nodeId is given, 'document' otherwise.
      // Unregistered facets pass through unvalidated (round-trip safety).
      // Registered payloads are stored as the schema's PARSED value. A null
      // payload deletes the key — deletion needs no target or schema check.
      //
      // Done ONCE for the whole batch, before any document is opened: the
      // payload is shared, so a rejected facet is rejected for every
      // document and there is nothing to be gained by discovering it on the
      // third one after the first two were already written.
      // The workspace's registry, not only the deployment's: a stencil its
      // own library defines must be writable HERE too, or the two paths that
      // dress a box disagree — `wb_canvas_edit` applying an id this tool
      // refuses is the shape a single composer exists to prevent.
      //
      // Resolved only when this batch writes a facet that TAKES a stencil.
      // A library can add nothing but stencil assets, so every other write —
      // a tag, a deletion, a shape — gets an identical answer from the
      // deployment's registry and must not pay a document listing for it.
      // Asked of the registry rather than against a hardcoded
      // `visual.stencil/v0`: which facets take a stencil is a plugin's
      // declaration, and a server spelling one plugin's key is a server no
      // other plugin extends.
      const deploymentRegistry = deps.facetRegistry ?? bundledFacetRegistry
      const writesAStencilRef = Object.entries(input.facets ?? {}).some(
        ([key, payload]) =>
          payload !== null &&
          Object.values(deploymentRegistry.assetRefsOf(key) ?? {}).includes('stencils'),
      )
      const registry = writesAStencilRef
        ? await workspaceFacetRegistry(deps, input.workspaceId, 'deployment')
        : deploymentRegistry
      const requiredTarget: FacetTarget =
        input.nodeId !== undefined
          ? 'node'
          : input.edgeId !== undefined
            ? 'edge'
            : (input.target ?? 'document')
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

      // Every document is confirmed to be in the workspace before any of
      // them is written. Each document is its own Loro doc with its own
      // snapshot and there is no transaction across them, so writing as we
      // go would leave a prefix of the batch tagged behind a thrown error —
      // and the caller reading that error has no way to learn it happened.
      for (const documentId of input.documentIds) {
        await assertDocumentInWorkspace(deps.documentIndex, input.workspaceId, documentId)
      }

      const updated: FacetSetOutput['updated'] = []
      for (const documentId of input.documentIds) {
        updated.push(await setOne(deps, input, documentId, sets, deletions))
      }
      return { updated }
    },
  }
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

  if (input.nodeId !== undefined) {
    const nodeId = input.nodeId
    // A kind-less document (freshly created, nothing declared) has no
    // canvas, so the node cannot exist — report THAT, rather than
    // fabricating a kind for the mismatch message.
    if (kind === undefined) {
      throw new NodeNotFoundError(documentId, nodeId)
    }
    if (kind !== 'spatial') {
      throw new DocumentKindMismatchError(
        documentId,
        kind,
        "Node-target facets live on a spatial document's node. Omit nodeId to set facets on a markdown document.",
      )
    }
    const canvas = readSpatialCanvas(doc)
    const node = canvas.nodes.find((candidate) => candidate.id === nodeId)
    if (node === undefined) {
      throw new NodeNotFoundError(documentId, nodeId)
    }
    const merged: ExtensionFacets = { ...node.facets, ...sets }
    for (const key of deletions) delete merged[key]
    // Canonical emptiness: an empty bucket disappears rather than being
    // stored as `{}`, so a node that set a facet and cleared it is identical
    // to one that never had it. The node's `embed` is untouched — they are
    // independent fields now, where the format's extension made them two arms
    // of a union and this branch had to preserve the other one by hand.
    const { facets: _replaced, ...nodeRest } = node
    const nextNode = (
      Object.keys(merged).length === 0 ? nodeRest : { ...nodeRest, facets: merged }
    ) as SpatialNode
    writeSpatialCanvas(doc, {
      ...canvas,
      nodes: canvas.nodes.map((candidate) => (candidate.id === nodeId ? nextNode : candidate)),
    })
    await saveDocumentSnapshot(deps, input.workspaceId, documentId, doc)
    return { documentId, facets: merged }
  }

  if (input.edgeId !== undefined) {
    const edgeId = input.edgeId
    // Same order as the node branch, and for the same reason: a kind-less
    // document has no canvas, so the edge cannot exist — say THAT rather
    // than fabricating a kind for a mismatch message.
    if (kind === undefined) {
      throw new EdgeNotFoundError(documentId, edgeId)
    }
    if (kind !== 'spatial') {
      throw new DocumentKindMismatchError(
        documentId,
        kind,
        "Edge-target facets live on a spatial document's edge. Omit edgeId to set facets on a markdown document.",
      )
    }
    const canvas = readSpatialCanvas(doc)
    const edge = canvas.edges.find((candidate) => candidate.id === edgeId)
    if (edge === undefined) {
      throw new EdgeNotFoundError(documentId, edgeId)
    }
    const merged: ExtensionFacets = { ...edge.facets, ...sets }
    for (const key of deletions) delete merged[key]
    // The same canonical emptiness the node and canvas branches keep: an
    // empty bucket disappears, so an edge that set a facet and cleared it
    // serializes identically to one that never had it.
    const { facets: _replaced, ...edgeRest } = edge
    const nextEdge: CanvasEdge =
      Object.keys(merged).length === 0 ? edgeRest : { ...edgeRest, facets: merged }
    writeSpatialCanvas(doc, {
      ...canvas,
      edges: canvas.edges.map((candidate) => (candidate.id === edgeId ? nextEdge : candidate)),
    })
    await saveDocumentSnapshot(deps, input.workspaceId, documentId, doc)
    return { documentId, facets: merged }
  }

  if (input.target === 'canvas') {
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
    // The same canonical emptiness the web editor's `withCanvasFacet` keeps:
    // an empty bucket disappears, so a reverted canvas never carries a
    // redundant field forever. The comments beside it are untouched.
    const { facets: _replaced, ...canvasRest } = canvas
    writeSpatialCanvas(
      doc,
      Object.keys(merged).length === 0 ? canvasRest : { ...canvasRest, facets: merged },
    )
    await saveDocumentSnapshot(deps, input.workspaceId, documentId, doc)
    return { documentId, facets: merged }
  }

  // A facet is OKF frontmatter (ADR-0009 decision 3). A JSON Canvas
  // document has nodes and edges and no frontmatter to put one in, so a
  // facet stored on one is metadata no reader of that format can surface
  // — written, kept, and invisible.
  //
  // A document with no kind is allowed through and NOT declared: unlike
  // an OKF content write this replaces nothing, so it has neither
  // something to lose nor any evidence to offer about the format.
  if (kind === 'spatial') {
    throw new DocumentKindMismatchError(
      documentId,
      kind,
      "Facets are OKF frontmatter, and a JSON Canvas document has none to hold them. Pass target: 'canvas' for canvas-target facets (a theme, edge routing), nodeId for node-target facets, set them on the markdown document this one refers to, or write its content with `wb_workspace_edit`'s `document.set` op.",
    )
  }

  const mergedFacets: ExtensionFacets = { ...readFacets(doc), ...sets }
  for (const key of deletions) delete mergedFacets[key]
  if (input.facets !== undefined) writeFacets(doc, mergedFacets)

  let tags: string[] | undefined
  if (input.tags !== undefined) {
    const core = readCoreFacets(doc)
    if (core === undefined) throw new DocumentHasNoFrontmatterError(documentId)
    const remove = new Set(input.tags.remove ?? [])
    const kept = (core.tags ?? []).filter((tag) => !remove.has(tag))
    const added = (input.tags.add ?? []).filter(
      (tag, i, all) => !kept.includes(tag) && all.indexOf(tag) === i,
    )
    tags = [...kept, ...added]
    // The whole core bucket goes back, tags included: writeCoreFacets
    // replaces rather than merges, and an omitted `tags` would drop them.
    const { tags: _previous, ...rest } = core
    writeCoreFacets(doc, tags.length === 0 ? rest : { ...rest, tags })
  }

  await saveDocumentSnapshot(deps, input.workspaceId, documentId, doc)

  return { documentId, facets: mergedFacets, ...(tags === undefined ? {} : { tags }) }
}
