import { z } from 'zod'

// Request/response schemas for the canvas / workspace mutation endpoints.
// Imported by routes/canvas.ts (validates incoming bodies) and by any client
// that wants to construct request bodies or parse responses with type help.

// GET /api/workspaces/:workspaceId/names — response body.
export const workspaceNamesSchema = z.object({
  workspace: z.string().optional(),
  canvases: z.record(z.string(), z.string()),
  pinned: z.array(z.string()),
})

export const createCanvasRequestSchema = z.object({
  slug: z.string().trim().min(1),
})

// `name: ''` deletes the stored name and falls back to the slug/workspaceId.
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

// POST /api/workspaces/:workspaceId/canvases/:slug/versions/:id/restore
// Body is optional. Two restore modes share the same endpoint:
//   • body absent or `targetSlug` absent — in-place reconcile against the
//     current canvas (default; what the History panel uses).
//   • `targetSlug` set — restore into that slug in the same workspace. If it
//     does not exist yet, this creates it. If it already exists, `overwrite:
//     true` is required, and the restore reconciles onto the target's live
//     doc (same semantics as the default mode, not a persistence swap) so
//     any client connected to that canvas stays on the same CRDT lineage.
//     Replaces what the now-removed `checkpoint_restore` flow did.
export const restoreVersionRequestSchema = z.object({
  targetSlug: z.string().trim().min(1).optional(),
  overwrite: z.boolean().optional(),
})

export const exportCanvasJsonRequestSchema = z.object({
  includeCustomFields: z.boolean().optional(),
  outputPath: z.string().optional(),
  overwrite: z.boolean().optional(),
})

// VersionEntry: a row in the canvas version history. The server hydrates
// missing legacy metadata before returning, so branchName is always present
// on the wire.
export const versionEntrySchema = z.object({
  id: z.string(),
  slug: z.string(),
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
export const problemDetailsErrorSchema = z.object({
  title: z.string().optional(),
})

// POST /api/workspaces/:workspaceId/canvases — success body.
export const createCanvasResponseSchema = z.object({
  slug: z.string(),
})

// POST /api/canvas/:workspaceId/:slug/update — success body.
export const updateCanvasResponseSchema = z.object({
  ok: z.literal(true),
})

// Workspace + canvas listings consumed by IndexPage to render the
// "open workspaces" grid.
export const workspaceSummarySchema = z.object({
  workspaceId: z.string(),
})

export const listWorkspacesResponseSchema = z.object({
  workspaces: z.array(workspaceSummarySchema),
})

export const canvasSummarySchema = z.object({
  slug: z.string(),
  updatedAt: z.string(),
})

export const listCanvasesResponseSchema = z.object({
  canvases: z.array(canvasSummarySchema),
})

export type CreateCanvasRequest = z.infer<typeof createCanvasRequestSchema>
export type SetNameRequest = z.infer<typeof setNameRequestSchema>
export type SetPinnedRequest = z.infer<typeof setPinnedRequestSchema>
export type OperatorInfo = z.infer<typeof operatorInfoSchema>
export type SaveVersionRequest = z.infer<typeof saveVersionRequestSchema>
export type RestoreVersionRequest = z.infer<typeof restoreVersionRequestSchema>
export type ExportCanvasJsonRequest = z.infer<typeof exportCanvasJsonRequestSchema>
export type VersionEntry = z.infer<typeof versionEntrySchema>
export type ListVersionsResponse = z.infer<typeof listVersionsResponseSchema>
export type SaveVersionResponse = z.infer<typeof saveVersionResponseSchema>
export type WorkspaceSummary = z.infer<typeof workspaceSummarySchema>
export type ListWorkspacesResponse = z.infer<typeof listWorkspacesResponseSchema>
export type CanvasSummary = z.infer<typeof canvasSummarySchema>
export type ListCanvasesResponse = z.infer<typeof listCanvasesResponseSchema>
export type ProblemDetailsError = z.infer<typeof problemDetailsErrorSchema>
export type CreateCanvasResponse = z.infer<typeof createCanvasResponseSchema>
export type UpdateCanvasResponse = z.infer<typeof updateCanvasResponseSchema>
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

// POST /api/workspaces/:workspaceId/canvases/optimize-all — response body.
// The route also returns a per-canvas `results` array; the Storage tab only
// needs the aggregated totals, so that detail is left unvalidated here
// rather than duplicating compactCanvas's result shape.
export const optimizeAllCanvasesResponseSchema = z.object({
  totalBeforeBytes: z.number().int().nonnegative(),
  totalAfterBytes: z.number().int().nonnegative(),
})

export type OptimizeAllCanvasesResponse = z.infer<typeof optimizeAllCanvasesResponseSchema>

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
