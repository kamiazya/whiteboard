import {
  branchMetaSchema,
  documentBranchesStateSchema,
  mergeBadgeSchema,
} from '@kamiazya/whiteboard-history'
import { z } from 'zod'

// Request / response schemas for the /api/workspaces/:sid/documents/:path/branches
// family. Imported by the route handler (validates incoming bodies + types its
// `c.json(...)` responses) and the React client (parses fetch responses) so a
// wire-format change has exactly one place to update.
//
// What a branch IS is not the wire's to say: `branchMetaSchema`, the
// document's branch state and a merge badge are `@kamiazya/whiteboard-history`'s,
// re-exported here so the route, the client and the mechanic parse one shape.
export { branchMetaSchema, documentBranchesStateSchema, mergeBadgeSchema }

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
  badges: z.array(mergeBadgeSchema),
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

export type { BranchMeta, DocumentBranchesState, MergeBadge } from '@kamiazya/whiteboard-history'
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
