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
import { DocumentKindMismatchError, FacetWriteRejectedError, NodeNotFoundError } from './errors.js'

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
    tags: tagsChangeSchema
      .optional()
      .describe(
        "Change the documents' OKF core tags: add and remove by name, every other tag stays. Markdown documents only.",
      ),
    /**
     * Where a write without `nodeId` lands: the documents themselves
     * (markdown frontmatter; the default), or the CANVAS envelope of a
     * spatial document (`x-whiteboard.facets` — ADR-0013 decision 5's
     * canvas slot, where `visual.theme/v0` and `visual.edges/v0` live).
     * Two answers rather than three, because `nodeId` already says "a node"
     * and saying it twice is how the two disagree.
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
export class NodeAndCanvasTargetError extends Error {
  constructor() {
    super(
      "nodeId targets one node and target: 'canvas' targets the canvas envelope; pass one or the other.",
    )
    this.name = 'NodeAndCanvasTargetError'
  }
}

export function createFacetSetTool(deps: ServerDeps) {
  return {
    name: 'wb_facet_set' as const,
    description:
      "Tag documents, or set facets on them. `tags` adds and removes OKF core tags by name on one or more markdown documents, leaving the other tags alone. `facets` sets extension facets (keys like `visual.shape/v0`; wb_facet_list says which are registered) on the documents, on a spatial document's canvas (target: 'canvas' — where visual.theme/v0 chooses a theme), or — with nodeId — on one node of a spatial document, merging by key: an omitted key keeps its stored value, null deletes it. Registered facets are validated against their schema, their declared targets, and the assets they name. One payload covers every document named, so tagging five notes is one call.",
    inputSchema: facetSetInputSchema,
    outputSchema: facetSetOutputSchema,
    execute: async (input: FacetSetInput): Promise<FacetSetOutput> => {
      if (input.tags === undefined && input.facets === undefined) {
        throw new FacetSetNeedsPayloadError()
      }
      if (input.nodeId !== undefined && input.tags !== undefined) {
        throw new TagsTargetDocumentError()
      }
      if (input.nodeId !== undefined && input.documentIds.length !== 1) {
        throw new NodeTargetNeedsOneDocumentError(input.documentIds.length)
      }
      if (input.nodeId !== undefined && input.target === 'canvas') {
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
      const registry = deps.facetRegistry ?? bundledFacetRegistry
      const requiredTarget = input.nodeId !== undefined ? 'node' : (input.target ?? 'document')
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
            `its targets are [${targets.join(', ')}], and this write targets a ${requiredTarget}`,
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
    const merged: ExtensionFacets = { ...node['x-whiteboard']?.facets, ...sets }
    for (const key of deletions) delete merged[key]
    const { facets: _replaced, ...extensionRest } = node['x-whiteboard'] ?? {}
    const nextExtension =
      Object.keys(merged).length === 0 ? extensionRest : { ...extensionRest, facets: merged }
    const { 'x-whiteboard': _extension, ...nodeRest } = node
    const nextNode = (
      Object.keys(nextExtension).length === 0
        ? nodeRest
        : { ...nodeRest, 'x-whiteboard': nextExtension }
    ) as SpatialNode
    writeSpatialCanvas(doc, {
      ...canvas,
      nodes: canvas.nodes.map((candidate) => (candidate.id === nodeId ? nextNode : candidate)),
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
    const merged: ExtensionFacets = { ...canvas['x-whiteboard']?.facets, ...sets }
    for (const key of deletions) delete merged[key]
    // The same canonical emptiness the web editor's `withCanvasFacet`
    // keeps: an empty bucket disappears, and an empty envelope with it, so
    // a reverted canvas never carries a redundant extension forever.
    const { facets: _replaced, ...extensionRest } = canvas['x-whiteboard'] ?? {}
    const nextExtension =
      Object.keys(merged).length === 0 ? extensionRest : { ...extensionRest, facets: merged }
    const { 'x-whiteboard': _extension, ...canvasRest } = canvas
    writeSpatialCanvas(
      doc,
      Object.keys(nextExtension).length === 0
        ? canvasRest
        : { ...canvasRest, 'x-whiteboard': nextExtension },
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
