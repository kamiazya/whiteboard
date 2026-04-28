import { z } from 'zod'

// Request / response schemas for the /api/workspaces/:sid/canvases/:slug/branches
// family. Imported by the route handler (validates incoming bodies + types its
// `c.json(...)` responses) and the React client (parses fetch responses) so a
// wire-format change has exactly one place to update.

export const branchMetaSchema = z.object({
  name: z.string(),
  tipFrontiers: z.string(),
  baseBranch: z.string().optional(),
  baseVersionId: z.string().optional(),
  color: z.string(),
  createdAt: z.string(),
})

export const canvasBranchesStateSchema = z.object({
  branches: z.array(branchMetaSchema),
  head: z.string(),
})

export const createBranchRequestSchema = z.object({
  name: z.string().min(1),
  fromVersionId: z.string().min(1).optional(),
  color: z.string().optional(),
})

export const createBranchResponseSchema = z.object({
  branch: branchMetaSchema,
})

export const deleteBranchResponseSchema = z.object({
  ok: z.literal(true),
  unmergedCommits: z.number().int().nonnegative(),
})

export const branchStatsResponseSchema = z.object({
  unmergedCommits: z.number().int().nonnegative(),
  isHead: z.boolean(),
})

export const renameBranchRequestSchema = z.object({
  name: z.string().min(1),
})

export const renameBranchResponseSchema = z.object({
  branch: branchMetaSchema,
  renamedVersionCount: z.number().int().nonnegative(),
})

export const setHeadRequestSchema = z.object({
  branch: z.string().min(1),
})

export const setHeadResponseSchema = z.object({
  head: z.string(),
  previousHead: z.string(),
})

export const mergeRequestSchema = z.object({
  into: z.string().min(1),
  dryRun: z.boolean().optional(),
})

// MergeDialog renders three columns (target / source / preview) and post-commit
// highlights, so several fields are optional depending on dryRun and on whether
// the deployment populates element-level preview metadata.
export const mergeResponseSchema = z.object({
  badges: z.array(z.record(z.string(), z.unknown())),
  preview: z.object({ elementCount: z.number() }).optional(),
  committed: z.object({ elementCount: z.number() }).optional(),
  target: z.object({ elementCount: z.number() }).optional(),
  source: z.object({ elementCount: z.number() }).optional(),
  previewElements: z.array(z.unknown()).optional(),
  newElementIds: z.array(z.string()).optional(),
  changedElementIds: z.array(z.string()).optional(),
  conflictElementIds: z.array(z.string()).optional(),
  preMergeVersionId: z.string().optional(),
  switchedHead: z.object({ from: z.string(), to: z.string() }).optional(),
  deletedSource: z.string().optional(),
})

export type BranchMeta = z.infer<typeof branchMetaSchema>
export type CanvasBranchesState = z.infer<typeof canvasBranchesStateSchema>
export type CreateBranchRequest = z.infer<typeof createBranchRequestSchema>
export type CreateBranchResponse = z.infer<typeof createBranchResponseSchema>
export type DeleteBranchResponse = z.infer<typeof deleteBranchResponseSchema>
export type BranchStatsResponse = z.infer<typeof branchStatsResponseSchema>
export type RenameBranchRequest = z.infer<typeof renameBranchRequestSchema>
export type RenameBranchResponse = z.infer<typeof renameBranchResponseSchema>
export type SetHeadRequest = z.infer<typeof setHeadRequestSchema>
export type SetHeadResponse = z.infer<typeof setHeadResponseSchema>
export type MergeRequest = z.infer<typeof mergeRequestSchema>
export type MergeResponse = z.infer<typeof mergeResponseSchema>
