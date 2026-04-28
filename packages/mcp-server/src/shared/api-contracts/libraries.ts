import { z } from 'zod'

// Request / response schemas for the /api/workspaces/:workspaceId/libraries
// and /api/user-libraries endpoints. Imported by the route handler (validates
// incoming bodies + types `c.json(...)` responses), the MCP library_* tools
// (parses fetch responses), and the persisted JSON manifest store so the wire
// shape and the on-disk shape stay in lockstep.

// ── Installed libraries (URL list) ─────────────────────────────────────────
export const installedLibrariesResponseSchema = z.array(z.string())

export const addInstalledLibraryRequestSchema = z.object({
  url: z.string().min(1),
})

export const removeInstalledLibraryRequestSchema = z.object({
  url: z.string().min(1),
})

// ── User library content (.excalidrawlib payload) ──────────────────────────
// Minimum-shape contract: `type` is `excalidrawlib` and `library` /
// `libraryItems` (when present) are arrays. Everything else passthroughs so
// v1 and v2 catalog formats both round-trip.
export const userLibraryContentSchema = z
  .object({
    type: z.literal('excalidrawlib'),
    library: z.array(z.unknown()).optional(),
    libraryItems: z.array(z.unknown()).optional(),
  })
  .passthrough()

// ── User library summary (registry row) ────────────────────────────────────
export const userLibrarySummarySchema = z.object({
  name: z.string(),
  path: z.string(),
  itemCount: z.number().int().nonnegative(),
})

export const listUserLibrariesResponseSchema = z.object({
  libraries: z.array(userLibrarySummarySchema),
})

export const saveUserLibraryRequestSchema = z.object({
  content: z.unknown(),
})

export const saveUserLibraryResponseSchema = z.object({
  name: z.string(),
  itemCount: z.number().int().nonnegative(),
})

export const removeUserLibraryResponseSchema = z.object({
  removed: z.string(),
  remaining: z.array(z.string()),
})

// ── User library metadata manifest ─────────────────────────────────────────
// Aliases / notes / scales are open string-keyed records keyed on item id.
export const userLibraryMetadataManifestSchema = z.object({
  version: z.literal(1),
  revision: z.number().int().nonnegative(),
  aliases: z.record(z.string(), z.number().int().finite()),
  notes: z.record(z.string(), z.string()),
  scales: z.record(z.string(), z.number().finite()),
})

export const setUserLibraryMetadataRequestSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    aliases: z.record(z.string(), z.number().int().finite()).optional(),
    notes: z.record(z.string(), z.string()).optional(),
    scales: z.record(z.string(), z.number().finite()).optional(),
  })
  .refine(
    (body) => body.aliases !== undefined || body.notes !== undefined || body.scales !== undefined,
    { message: 'at least one of aliases, notes, or scales is required' },
  )

export const deleteUserLibraryMetadataRequestSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    aliasKeys: z.array(z.string()).optional(),
    noteKeys: z.array(z.string()).optional(),
    scaleKeys: z.array(z.string()).optional(),
  })
  .refine(
    (body) =>
      body.aliasKeys !== undefined || body.noteKeys !== undefined || body.scaleKeys !== undefined,
    { message: 'at least one of aliasKeys, noteKeys, or scaleKeys is required' },
  )

export type InstalledLibrariesResponse = z.infer<typeof installedLibrariesResponseSchema>
export type AddInstalledLibraryRequest = z.infer<typeof addInstalledLibraryRequestSchema>
export type RemoveInstalledLibraryRequest = z.infer<typeof removeInstalledLibraryRequestSchema>
export type UserLibraryContent = z.infer<typeof userLibraryContentSchema>
export type UserLibrarySummary = z.infer<typeof userLibrarySummarySchema>
export type ListUserLibrariesResponse = z.infer<typeof listUserLibrariesResponseSchema>
export type SaveUserLibraryRequest = z.infer<typeof saveUserLibraryRequestSchema>
export type SaveUserLibraryResponse = z.infer<typeof saveUserLibraryResponseSchema>
export type RemoveUserLibraryResponse = z.infer<typeof removeUserLibraryResponseSchema>
export type UserLibraryMetadataManifest = z.infer<typeof userLibraryMetadataManifestSchema>
export type SetUserLibraryMetadataRequest = z.infer<typeof setUserLibraryMetadataRequestSchema>
export type DeleteUserLibraryMetadataRequest = z.infer<
  typeof deleteUserLibraryMetadataRequestSchema
>
