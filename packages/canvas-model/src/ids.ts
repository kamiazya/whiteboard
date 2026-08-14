import { z } from 'zod'

// Canonical ULID: 26 chars of Crockford base32 (excludes I, L, O, U to avoid
// visual confusion with 1, 1, 0, V). The first character is additionally
// restricted to 0-7 because a ULID packs a 48-bit timestamp + 80-bit
// randomness into 128 bits total; the leading base32 digit only ever
// contributes its low 3 bits to that 128-bit value, so 8-Z there would
// overflow the spec's bit layout. See https://github.com/ulid/spec.
const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/

/** Canvas identifiers are canonical ULIDs (sortable, collision-resistant). */
export const canvasIdSchema = z.string().regex(ULID_PATTERN, 'must be a canonical ULID')

/**
 * Node identifiers are nanoid-style strings. The charset is deliberately not
 * enforced here — nanoid's default alphabet may change or be swapped for a
 * custom one — only non-emptiness is a real invariant.
 */
export const nodeIdSchema = z.string().min(1, 'node id must not be empty')

/**
 * Workspace identifiers are a path-safe SLUG, not a ULID — deliberately
 * different from `canvasIdSchema`. This codifies the workspace-ID contract
 * already enforced at runtime by mcp-server's `SAFE_WORKSPACE_ID`
 * (`/^[a-zA-Z0-9_-]+$/`, non-empty): workspace ids are used directly as
 * path segments and cache/index keys, so `.`/`/`/whitespace/non-ASCII must
 * stay rejected to prevent path traversal and key collisions.
 */
const WORKSPACE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/

export const workspaceIdSchema = z
  .string()
  .min(1)
  .regex(WORKSPACE_ID_PATTERN, 'workspace id must be a path-safe slug ([a-zA-Z0-9_-]+)')

/**
 * One segment of a document path. Codifies the rule mcp-server enforces at
 * runtime as `SAFE_SLUG_SEGMENT`: ASCII letters and digits, hyphens only in
 * the interior. `.` is absent from the character class rather than merely
 * unmatched, which is what forecloses `..` traversal once segments are
 * joined into a filesystem-shaped path.
 */
export const DOCUMENT_PATH_SEGMENT_PATTERN = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/

/**
 * A document's address within its workspace: segments joined by `/`.
 * Hierarchy lives in this string rather than in a parent pointer, the way a
 * filesystem stores paths rather than a tree — sibling uniqueness then falls
 * out of path uniqueness. Interior `/` is the separator and nothing else, so
 * a leading, trailing or repeated one is rejected: it would name an empty
 * segment.
 */
export const documentPathSchema = z
  .string()
  .min(1)
  .refine(
    (path) => path.split('/').every((segment) => DOCUMENT_PATH_SEGMENT_PATTERN.test(segment)),
    'each segment must be non-empty and contain only ASCII letters, digits and interior hyphens',
  )

export type CanvasId = z.infer<typeof canvasIdSchema>
export type DocumentPath = z.infer<typeof documentPathSchema>
export type NodeId = z.infer<typeof nodeIdSchema>
export type WorkspaceId = z.infer<typeof workspaceIdSchema>
