import { canvasIdSchema, workspaceIdSchema } from '@kamiazya/whiteboard-canvas-model'
import { z } from 'zod'

// -- Row schemas ------------------------------------------------------------
// These five rows are documented-derived: their *derivation* (how a facet
// index or backlink table is built from canvas content) belongs to
// canvas-workspace. canvas-ports only declares the row shapes and makes NO
// rebuildability claim.

export const facetIndexRowSchema = z
  .object({
    facet: z.string().min(1),
    value: z.string(),
    canvasId: canvasIdSchema,
  })
  .strict()
export type FacetIndexRow = z.infer<typeof facetIndexRowSchema>

export const canvasListRowSchema = z
  .object({
    canvasId: canvasIdSchema,
    title: z.string(),
    updatedAtMs: z.number().int().min(0),
  })
  .strict()
export type CanvasListRow = z.infer<typeof canvasListRowSchema>

export const aliasResolutionRowSchema = z
  .object({
    alias: z.string().min(1),
    canvasId: canvasIdSchema,
  })
  .strict()
export type AliasResolutionRow = z.infer<typeof aliasResolutionRowSchema>

export const backlinkRowSchema = z
  .object({
    fromCanvasId: canvasIdSchema,
    toCanvasId: canvasIdSchema,
  })
  .strict()
export type BacklinkRow = z.infer<typeof backlinkRowSchema>

export const aliasHistoryRowSchema = z
  .object({
    alias: z.string().min(1),
    canvasId: canvasIdSchema,
    retiredAtMs: z.number().int().min(0),
  })
  .strict()
export type AliasHistoryRow = z.infer<typeof aliasHistoryRowSchema>

// -- Method DTOs --------------------------------------------------------------
// Every input DTO carries `workspaceId` so a single WorkspaceIndex instance
// can back many workspaces and each call self-describes its scope — this is
// the isolation boundary an implementation must enforce per call.

export const applyRowsInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    canvasList: z.array(canvasListRowSchema),
    facets: z.array(facetIndexRowSchema),
    aliases: z.array(aliasResolutionRowSchema),
    backlinks: z.array(backlinkRowSchema),
    aliasHistory: z.array(aliasHistoryRowSchema),
  })
  .strict()
export type ApplyRowsInput = z.infer<typeof applyRowsInputSchema>

export const resolveAliasInputSchema = z
  .object({ workspaceId: workspaceIdSchema, alias: z.string().min(1) })
  .strict()
export type ResolveAliasInput = z.infer<typeof resolveAliasInputSchema>

export const resolveAliasResultSchema = z.object({ canvasId: canvasIdSchema }).strict().nullable()
export type ResolveAliasResult = z.infer<typeof resolveAliasResultSchema>

export const resolveAliasHistoryInputSchema = z
  .object({ workspaceId: workspaceIdSchema, alias: z.string().min(1) })
  .strict()
export type ResolveAliasHistoryInput = z.infer<typeof resolveAliasHistoryInputSchema>

export const listCanvasesInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    limit: z.number().int().positive().optional(),
    offset: z.number().int().min(0).optional(),
  })
  .strict()
export type ListCanvasesInput = z.infer<typeof listCanvasesInputSchema>

export const listCanvasesResultSchema = z.object({ rows: z.array(canvasListRowSchema) }).strict()
export type ListCanvasesResult = z.infer<typeof listCanvasesResultSchema>

export const queryFacetInputSchema = z
  .object({ workspaceId: workspaceIdSchema, facet: z.string().min(1), value: z.string() })
  .strict()
export type QueryFacetInput = z.infer<typeof queryFacetInputSchema>

export const queryFacetResultSchema = z.object({ canvasIds: z.array(canvasIdSchema) }).strict()
export type QueryFacetResult = z.infer<typeof queryFacetResultSchema>

export const listBacklinksInputSchema = z
  .object({ workspaceId: workspaceIdSchema, toCanvasId: canvasIdSchema })
  .strict()
export type ListBacklinksInput = z.infer<typeof listBacklinksInputSchema>

export const listBacklinksResultSchema = z.object({ rows: z.array(backlinkRowSchema) }).strict()
export type ListBacklinksResult = z.infer<typeof listBacklinksResultSchema>

/**
 * Read/write access to a workspace's derived indices (facets, canvas list,
 * alias resolution + history, backlinks). Every method is workspace-scoped
 * via its input DTO's `workspaceId`, not via a per-workspace instance — an
 * implementation MUST use that field as its isolation boundary so one index
 * can safely back many workspaces.
 */
export interface WorkspaceIndex {
  applyRows(input: ApplyRowsInput): Promise<void>
  resolveAlias(input: ResolveAliasInput): Promise<ResolveAliasResult>
  resolveAliasHistory(input: ResolveAliasHistoryInput): Promise<ResolveAliasResult>
  listCanvases(input: ListCanvasesInput): Promise<ListCanvasesResult>
  queryFacet(input: QueryFacetInput): Promise<QueryFacetResult>
  listBacklinks(input: ListBacklinksInput): Promise<ListBacklinksResult>
}
