import { z } from 'zod'

// Request body schemas for the canvas / workspace mutation endpoints. Imported
// by routes/canvas.ts (validates incoming bodies) and by any client that wants
// to construct the request bodies with type help. Response shapes mostly come
// from server stores (WorkspaceNames etc.) and are not redefined here to keep
// the schema thin; only the wire-only request shapes belong here.

export const createCanvasRequestSchema = z.object({
  slug: z.string().trim().min(1),
})

export const createCheckpointRequestSchema = z.object({
  sourceSlug: z.string().trim().min(1),
  checkpointId: z.string().trim().min(1).optional(),
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

export const restoreCheckpointRequestSchema = z.object({
  targetSlug: z.string().trim().min(1),
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

// Workspace + canvas listings consumed by IndexPage to render the
// "open workspaces" grid.
export const workspaceSummarySchema = z.object({
  workspaceId: z.string(),
  daemonAlive: z.boolean(),
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
export type CreateCheckpointRequest = z.infer<typeof createCheckpointRequestSchema>
export type SetNameRequest = z.infer<typeof setNameRequestSchema>
export type SetPinnedRequest = z.infer<typeof setPinnedRequestSchema>
export type OperatorInfo = z.infer<typeof operatorInfoSchema>
export type SaveVersionRequest = z.infer<typeof saveVersionRequestSchema>
export type RestoreCheckpointRequest = z.infer<typeof restoreCheckpointRequestSchema>
export type ExportCanvasJsonRequest = z.infer<typeof exportCanvasJsonRequestSchema>
export type VersionEntry = z.infer<typeof versionEntrySchema>
export type ListVersionsResponse = z.infer<typeof listVersionsResponseSchema>
export type SaveVersionResponse = z.infer<typeof saveVersionResponseSchema>
export type WorkspaceSummary = z.infer<typeof workspaceSummarySchema>
export type ListWorkspacesResponse = z.infer<typeof listWorkspacesResponseSchema>
export type CanvasSummary = z.infer<typeof canvasSummarySchema>
export type ListCanvasesResponse = z.infer<typeof listCanvasesResponseSchema>
