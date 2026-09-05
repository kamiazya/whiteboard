import {
  documentKindSchema,
  spatialCanvasSchema,
  workspaceDisplayNameSchema,
  workspaceSegmentSchema,
} from '@kamiazya/whiteboard-model'
import { z } from 'zod'

// Request/response schemas for the canvas / workspace mutation endpoints.
// Imported by routes/document.ts (validates incoming bodies) and by any client
// that wants to construct request bodies or parse responses with type help.

// GET /api/workspaces/:workspaceId/names — response body.
export const workspaceNamesSchema = z.object({
  workspace: z.string().optional(),
  documents: z.record(z.string(), z.string()),
  pinned: z.array(z.string()),
})

export const createDocumentRequestSchema = z.object({
  path: z.string().trim().min(1),
  // Defaulted so every existing caller (which posts { path } alone) keeps
  // creating a spatial canvas byte-identically to before this field existed.
  kind: documentKindSchema.default('spatial'),
  // What a human reads, applied by the same request that creates the
  // document — the shape wb_document_create has always had. Split into a
  // create then a PUT /name, the second half can fail alone and leave a
  // document the user named sitting in the list as untitled-N.
  //
  // Optional because naming must never gate creation (ADR-0006 point 3):
  // omitted, the document has no name of its own and readers fall back to
  // the path's last segment.
  name: z.string().optional(),
})

// `name: ''` deletes the stored name and falls back to the path/workspaceId.
export const setNameRequestSchema = z.object({
  name: z.string(),
})

export const setPinnedRequestSchema = z.object({
  pinned: z.boolean(),
})

// OperatorInfo is declared in server-core beside the VersionHistory seam
// and re-exported here so this barrel stays the one place apps/web reads a
// daemon contract from.
import { operatorInfoSchema, versionEntrySchema } from '@kamiazya/whiteboard-server-core'

export { operatorInfoSchema, versionEntrySchema }

export const saveVersionRequestSchema = z.object({
  label: z.string().optional(),
  operator: operatorInfoSchema.optional(),
})

// POST /api/workspaces/:workspaceId/documents/:path/versions/:id/restore
// Body is optional. Two restore modes share the same endpoint:
//   • body absent or `targetPath` absent — in-place reconcile against the
//     current canvas (default; what the History panel uses).
//   • `targetPath` set — restore into that path in the same workspace. If it
//     does not exist yet, this creates it. If it already exists, `overwrite:
//     true` is required, and the restore reconciles onto the target's live
//     doc (same semantics as the default mode, not a persistence swap) so
//     any client connected to that canvas stays on the same CRDT lineage.
//     Replaces what the now-removed `checkpoint_restore` flow did.
export const restoreVersionRequestSchema = z.object({
  targetPath: z.string().trim().min(1).optional(),
  overwrite: z.boolean().optional(),
  /**
   * In-place mode only: roll the document AND its descendants back to this
   * version — descendants revert, documents deleted since come back, and
   * documents created since are deleted (evacuated through the trash).
   * Requires a workspace-scoped version; incompatible with `targetPath`.
   */
  subtree: z.boolean().optional(),
})

export const exportDocumentJsonRequestSchema = z.object({
  includeCustomFields: z.boolean().optional(),
  outputPath: z.string().optional(),
  overwrite: z.boolean().optional(),
})

/**
 * A past state, as the History panel PREVIEWS it before deciding to restore.
 *
 * Projected server-side rather than shipped as CRDT bytes: what the panel
 * needs is something to draw, and every surface that draws a document
 * already speaks these two shapes. It also keeps the contract inspectable —
 * a snapshot on the wire would be opaque to everything but Loro.
 *
 * Discriminated on `kind` so a reader cannot mistake an empty canvas for a
 * markdown document with no body.
 */
export const versionDocumentResponseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('spatial'), canvas: spatialCanvasSchema }),
  z.object({ kind: z.literal('markdown'), body: z.string() }),
])
export type VersionDocumentResponse = z.infer<typeof versionDocumentResponseSchema>

export const listVersionsResponseSchema = z.object({
  versions: z.array(versionEntrySchema),
})

export const saveVersionResponseSchema = z.object({
  version: versionEntrySchema,
})

// RFC 7807 / RFC 9457 Problem Details error response. Only the fields the UI
// needs to surface a human-readable error string without leaking server internals.
// POST /api/workspaces/:workspaceId/documents — success body.
export const createDocumentResponseSchema = z.object({
  path: z.string(),
})

// POST /api/w/:workspaceId/document/<path>/update — success body.
export const updateDocumentResponseSchema = z.object({
  ok: z.literal(true),
})

// DELETE /api/workspaces/:workspaceId/documents/:path — success body.
// The trash: what a delete evacuated, listed for a human and restorable by
// documentId. Metadata only — blob digests are the store's business and
// never cross this boundary.
export const trashEntrySummarySchema = z
  .object({
    documentId: z.string().min(1),
    path: z.string().min(1),
    deletedAt: z.number().int().nonnegative(),
  })
  .strict()

export const listTrashResponseSchema = z.object({
  entries: z.array(trashEntrySummarySchema),
})

export const restoreTrashResponseSchema = z.object({
  restored: z
    .object({
      documentId: z.string().min(1),
      path: z.string().min(1),
    })
    .strict(),
})

export const deleteDocumentResponseSchema = z.object({
  ok: z.literal(true),
})

// PUT /api/workspaces/:workspaceId/documents/:path/path — request body.
export const renameDocumentPathRequestSchema = z.object({
  path: z.string().trim().min(1),
})

// PUT /api/workspaces/:workspaceId/documents/:path/path — success body.
export const renameDocumentPathResponseSchema = z.object({
  path: z.string(),
})

// GET /api/w/:workspaceId/document/<path>/exists — success body. Read-only lookup
// so callers can distinguish "canvas not yet created" from a live doc,
// without the snapshot/update routes' silent lazy-create side effect.
export const canvasExistsResponseSchema = z.object({
  exists: z.boolean(),
})

// Workspace + canvas listings consumed by IndexPage to render the
// "open workspaces" grid.
//
// ADR-0019's user-facing (`segment`) and naming (`displayName`) layers, both
// optional: a workspace minted before that migration, or served by an
// implementation that has not adopted it yet (apps/web's browser registry,
// today), has neither, and an invented value would read as fact where there
// is none. Both fields are additive to keep an old daemon's response and a
// new client — and a new daemon's response and an old client — mutually
// parseable.
// Both WRITES answer with this same shape, deliberately: a create and a rename
// each hand back the workspace as it now stands, so a caller that has just
// moved an address does not have to re-list to learn the handle it should use
// next. One workspace is one workspace whichever call produced it, and a
// second name for the identical schema would be a synonym to keep in step.
export const workspaceSummarySchema = z.object({
  workspaceId: z.string(),
  segment: workspaceSegmentSchema.optional(),
  displayName: workspaceDisplayNameSchema.optional(),
  /**
   * How many documents the workspace holds — what makes a switcher row worth
   * reading, since a list of names alone gives no reason to pick one.
   *
   * SHADOWED documents count. A concurrent create can leave two documents on
   * one path, and the listing shows both (one marked) precisely so the
   * convergent state is visible rather than hidden; a count that quietly
   * omitted the marked one would put back the disagreement the mark exists to
   * prevent.
   *
   * Optional for the same additive reason as the two layers above, and
   * absent is not zero: zero means "this workspace is empty", which is
   * exactly the row a person needs to recognise, while absent means the
   * responder did not count. Only a keeper that cannot count leaves it out.
   */
  documentCount: z.number().int().nonnegative().optional(),
})

export const listWorkspacesResponseSchema = z.object({
  workspaces: z.array(workspaceSummarySchema),
})

/**
 * POST /api/workspaces — create one.
 *
 * What a person supplies is a DISPLAY NAME, and only that. The other two
 * layers are not the caller's to choose: ADR-0019 makes `workspaceId` a
 * machine-minted ULID, and the segment is DERIVED from the name here so the
 * one switcher control behaves the same on either keeper — the browser's
 * `createBrowserWorkspace` has taken a display name and derived from it since
 * it shipped, and two creation surfaces that disagree about what a caller
 * supplies is the asymmetry this contract exists to avoid.
 *
 * Choosing the address is what RENAME is for, one call later, where a
 * collision can be reported against a workspace that already exists.
 */
export const createWorkspaceRequestSchema = z.object({
  displayName: workspaceDisplayNameSchema,
})

/**
 * PATCH /api/workspaces/:workspaceId — rename the two chosen layers.
 *
 * PATCH rather than PUT because the port's contract is partial in a way PUT
 * cannot express: a field ABSENT means "leave this layer alone", never "clear
 * it". Under PUT, a client sending only a display name would be asking to drop
 * the segment — which is the one reading a caller would never intend, and the
 * reason `RenameWorkspaceInput` has no way to clear a layer at all.
 */
export const renameWorkspaceRequestSchema = z.object({
  segment: workspaceSegmentSchema.optional(),
  displayName: workspaceDisplayNameSchema.optional(),
})

export const documentSummarySchema = z.object({
  path: z.string(),
  // The immutable id behind the path (the documents row's nanoid PK).
  // Stored references (file nodes) key on this so a path rename cannot
  // dangle them (ADR-0008: stored links key on ids); the path stays the
  // user-facing, URL-addressed identity. Deliberately not pattern-bound:
  // clients must treat it as opaque and resolve refs by LOOKUP, never by
  // format — the nanoid alphabet overlaps the path charset.
  // Required: every row has the id, and the workspace-granularity sync
  // contract binds a session's content by it, so a summary without one
  // would leave the client no document to sync.
  id: z.string().min(1),
  // The name the user actually chose, ABSENT when they never chose one. The
  // path is an auto-generated ASCII address ('untitled-2') that cannot carry
  // a title in most scripts, so it is an identity for the URL and never one
  // for a reader. Carried on this list precisely so a client resolving a
  // `[[Name]]` reference reads the name from the same response it renders
  // the list from — the split is what let the two disagree.
  displayName: z.string().min(1).optional(),
  // Optional, matching `DocumentEntry`, which is optional because an index
  // may genuinely not own a timestamp — apps/web's IndexedDB index reads them
  // from a separate store. The daemon's SQL index always has one, so this
  // surface still reports it in practice; what changed is that the TYPE no
  // longer claims a guarantee the port cannot make. Every UI site that
  // renders it already treated absence as "no age to show".
  updatedAt: z.string().optional(),
  // Optional to match `DocumentEntry`, which this adapter reads from. In
  // practice every listed document carries one — a workspace-tree entry
  // cannot be kindless (the node meta schema requires it) — but the type
  // follows the port's promise rather than claiming more.
  kind: documentKindSchema.optional(),
  // The losing side of a converged path collision, carried from the port's
  // DocumentEntry so the daemon-connected file browser can badge it the way
  // the browser-kept one does.
  shadowed: z.literal(true).optional(),
  // The identity of the document's content as of this listing — what a
  // cached picture of it is a picture OF. Opaque, equality only. Carried
  // from the port's `DocumentEntry`, and optional for its reason: an index
  // that does not hold the content cannot derive one. The daemon's tree index
  // always does, so in practice every row has it; a client that finds it
  // absent must not memoise a render of that row.
  contentDigest: z.string().min(1).optional(),
})

export const listDocumentsResponseSchema = z.object({
  documents: z.array(documentSummarySchema),
})

export type CreateDocumentRequest = z.infer<typeof createDocumentRequestSchema>
export type SetNameRequest = z.infer<typeof setNameRequestSchema>
export type SetPinnedRequest = z.infer<typeof setPinnedRequestSchema>
export type OperatorInfo = z.infer<typeof operatorInfoSchema>
export type SaveVersionRequest = z.infer<typeof saveVersionRequestSchema>
export type RestoreVersionRequest = z.infer<typeof restoreVersionRequestSchema>
export type ExportDocumentJsonRequest = z.infer<typeof exportDocumentJsonRequestSchema>
export type VersionEntry = z.infer<typeof versionEntrySchema>
export type ListVersionsResponse = z.infer<typeof listVersionsResponseSchema>
export type SaveVersionResponse = z.infer<typeof saveVersionResponseSchema>
export type WorkspaceSummary = z.infer<typeof workspaceSummarySchema>
export type ListWorkspacesResponse = z.infer<typeof listWorkspacesResponseSchema>
export type CreateWorkspaceRequest = z.infer<typeof createWorkspaceRequestSchema>
export type RenameWorkspaceRequest = z.infer<typeof renameWorkspaceRequestSchema>
export type DocumentSummary = z.infer<typeof documentSummarySchema>
export type ListDocumentsResponse = z.infer<typeof listDocumentsResponseSchema>
export type CreateDocumentResponse = z.infer<typeof createDocumentResponseSchema>
export type UpdateDocumentResponse = z.infer<typeof updateDocumentResponseSchema>
export type DeleteDocumentResponse = z.infer<typeof deleteDocumentResponseSchema>
export type TrashEntrySummary = z.infer<typeof trashEntrySummarySchema>
export type ListTrashResponse = z.infer<typeof listTrashResponseSchema>
export type RestoreTrashResponse = z.infer<typeof restoreTrashResponseSchema>
export type RenameDocumentPathRequest = z.infer<typeof renameDocumentPathRequestSchema>
export type RenameDocumentPathResponse = z.infer<typeof renameDocumentPathResponseSchema>
export type DocumentExistsResponse = z.infer<typeof canvasExistsResponseSchema>
export type WorkspaceNames = z.infer<typeof workspaceNamesSchema>

// GET /api/runtime/storage — response body.
export const storageBucketSchema = z.object({
  bytes: z.number(),
  files: z.number(),
})

/**
 * The categories the walk in `routes/runtime-storage.ts` can put a file in.
 *
 * Enumerated rather than left as `z.record(z.string(), …)`, because a loose
 * record makes a category the server can never emit indistinguishable from one
 * it simply has not filled in yet. The Storage tab read it that way and
 * rendered a `libraries` row — a feature whose server half was deleted — as a
 * permanent 0 B instead of failing, which is what a contract with no key
 * constraint buys.
 *
 * `runtime-storage.ts` derives its report type from this, and the client
 * derives its row list from it, so all three cannot disagree.
 *
 * Note this makes the payload exhaustive at RUNTIME too, not only in the
 * types: `z.record` over an enum requires every key, so a report missing a
 * category is rejected rather than parsed with that bucket absent. Measured
 * — a payload carrying only `blobs` fails with six `invalid_type` issues.
 * That is the intent. The walk initialises all seven buckets on every run, so
 * a missing one means the producer changed, and failing loudly beats a client
 * rendering 0 B for a category that is no longer being counted.
 */
export const storageCategorySchema = z.enum([
  'blobs',
  'versions',
  'files',
  'exports',
  'logs',
  'db',
  'other',
])

export const storageReportPayloadSchema = z.object({
  totalBytes: z.number(),
  fileCount: z.number(),
  byCategory: z.record(storageCategorySchema, storageBucketSchema),
  lastAutoCompactedAt: z.number().nullable().optional(),
})

export type StorageCategory = z.infer<typeof storageCategorySchema>
export type StorageBucket = z.infer<typeof storageBucketSchema>
export type StorageReportPayload = z.infer<typeof storageReportPayloadSchema>

// POST /api/workspaces/:workspaceId/documents/optimize-all — response body.
// The route also returns a per-canvas `results` array; the Storage tab only
// needs the aggregated totals, so that detail is left unvalidated here
// rather than duplicating compactDocument's result shape.
export const optimizeAllDocumentsResponseSchema = z.object({
  totalBeforeBytes: z.number().int().nonnegative(),
  totalAfterBytes: z.number().int().nonnegative(),
})

export type OptimizeAllDocumentsResponse = z.infer<typeof optimizeAllDocumentsResponseSchema>

// POST /api/workspaces/:workspaceId/versions/prune-sandwiched — response body.
export const pruneSandwichedVersionsResponseSchema = z.object({
  totalDeleted: z.number().int().nonnegative(),
})

export type PruneSandwichedVersionsResponse = z.infer<typeof pruneSandwichedVersionsResponseSchema>

// Shared response shape for the two file-purge endpoints that wrap
// file-gc.ts's PurgeResult: POST /api/runtime/logs/prune and
// POST /api/workspaces/:workspaceId/files/purge-dangling.
export const purgeResultSchema = z.object({
  purgedCount: z.number().int().nonnegative(),
  purgedBytes: z.number().int().nonnegative(),
  /**
   * Why a pass purged nothing, when the reason is not "nothing was
   * dangling". Absent on an ordinary pass.
   *
   * `record-moved`: another instance wrote to this workspace while the pass
   * was deciding what was referenced, so the decision was made against a
   * record that no longer exists and the pass stood down (ADR-0020). Purging
   * is periodic, so standing down costs a cycle and nothing else — which is
   * the whole reason a fence is affordable here.
   *
   * `backup-in-progress`: a backup is assembling this data directory. It
   * captures the rows as a snapshot and the uploads as a directory copy, and
   * those are two moments; unlinking between them removes a file the snapshot
   * still references, so the backup restores to a document pointing at
   * nothing (ADR-0021 decision 6's far end). Same affordability argument as
   * above — a skipped pass happens again on the next tick.
   */
  skippedReason: z.enum(['record-moved', 'backup-in-progress']).optional(),
})

export type PurgeResult = z.infer<typeof purgeResultSchema>
