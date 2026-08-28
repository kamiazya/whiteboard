import {
  documentKindSchema,
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

// OperatorInfo: who saved the version. The version-store also accepts this
// shape via VersionStore.save({ operator }).
export const operatorInfoSchema = z.object({
  kind: z.enum(['ai', 'human', 'system']),
  peerId: z.string().min(1),
  displayName: z.string().optional(),
  agentId: z.string().optional(),
  workspaceId: z.string().optional(),
})

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

// VersionEntry: a row in the canvas version history. The server hydrates
// missing legacy metadata before returning, so branchName is always present
// on the wire.
export const versionEntrySchema = z.object({
  id: z.string(),
  path: z.string(),
  createdAt: z.string(),
  elementCount: z.number().finite(),
  label: z.string().optional(),
  auto: z.boolean(),
  operator: operatorInfoSchema.optional(),
  hasThumbnail: z.boolean(),
  branchName: z.string(),
})

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
export const workspaceSummarySchema = z.object({
  workspaceId: z.string(),
  segment: workspaceSegmentSchema.optional(),
  displayName: workspaceDisplayNameSchema.optional(),
})

export const listWorkspacesResponseSchema = z.object({
  workspaces: z.array(workspaceSummarySchema),
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

export const storageReportPayloadSchema = z.object({
  totalBytes: z.number(),
  fileCount: z.number(),
  byCategory: z.record(z.string(), storageBucketSchema),
  lastAutoCompactedAt: z.number().nullable().optional(),
})

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
})

export type PurgeResult = z.infer<typeof purgeResultSchema>
