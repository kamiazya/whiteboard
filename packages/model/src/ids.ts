import { z } from 'zod'

// Canonical ULID: 26 chars of Crockford base32 (excludes I, L, O, U to avoid
// visual confusion with 1, 1, 0, V). The first character is additionally
// restricted to 0-7 because a ULID packs a 48-bit timestamp + 80-bit
// randomness into 128 bits total; the leading base32 digit only ever
// contributes its low 3 bits to that 128-bit value, so 8-Z there would
// overflow the spec's bit layout. See https://github.com/ulid/spec.
const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/

/**
 * Document identifiers are canonical ULIDs (sortable, collision-resistant).
 * This is the same canonical-ULID shape a workspace's canonical id uses
 * below (`workspaceCanonicalIdSchema`) — both delegate to `ULID_PATTERN`
 * rather than restating it, so the two cannot drift apart.
 */
export const documentIdSchema = z.string().regex(ULID_PATTERN, 'must be a canonical ULID')

/**
 * Node identifiers are nanoid-style strings. The charset is deliberately not
 * enforced here — nanoid's default alphabet may change or be swapped for a
 * custom one — only non-emptiness is a real invariant.
 */
export const nodeIdSchema = z.string().min(1, 'node id must not be empty')

/**
 * Legacy workspace identifier shape, retained for the live data both
 * keepers already hold on disk today (the daemon's `workspaces.id` column,
 * the browser's hard-coded `'local'`). This codifies the contract already
 * enforced at runtime by mcp-server's `SAFE_WORKSPACE_ID`
 * (`/^[a-zA-Z0-9_-]+$/`, non-empty): workspace ids are used directly as
 * path segments and cache/index keys, so `.`/`/`/whitespace/non-ASCII must
 * stay rejected to prevent path traversal and key collisions.
 *
 * ADR-0019 replaces this single string's three overloaded roles with three
 * separate schemas below (`workspaceCanonicalIdSchema` / `workspaceSegmentSchema`
 * / `workspaceDisplayNameSchema`), mirroring the document layer's id / path /
 * displayName split. This schema's shape is untouched by that decision —
 * re-keying live data onto the new canonical-id shape is a later, migration-
 * driven slice, not this one.
 */
const WORKSPACE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/

export const workspaceIdSchema = z
  .string()
  .min(1)
  .regex(WORKSPACE_ID_PATTERN, 'workspace id must be a path-safe path ([a-zA-Z0-9_-]+)')

/**
 * One segment of a document path. Codifies the rule mcp-server enforces at
 * runtime as `DOCUMENT_PATH_SEGMENT_PATTERN`: ASCII letters and digits, hyphens only in
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

/**
 * A workspace's canonical identifier (ADR-0019): a bare ULID, the same
 * shape `documentIdSchema` uses and delegating to the same `ULID_PATTERN`.
 * No `ws_` prefix — a prefix was considered as defense-in-depth against
 * confusing a workspace id with a document id and rejected, because
 * `documentId` is already unprefixed and a prefix would buy only an
 * asymmetry; the confusion is guarded the way this codebase guards
 * everything else, with distinct Zod schemas (this one is a separate type
 * from `documentIdSchema` despite sharing a pattern) and tests, not string
 * shape. This is the only key references, versions/branches, storage rows,
 * and sync ever use — never shown as chrome, never typed by a human.
 */
export const workspaceCanonicalIdSchema = z.string().regex(ULID_PATTERN, 'must be a canonical ULID')

/**
 * A workspace's user-facing handle (ADR-0019): unique per keeper, renameable,
 * URL-safe. Uniqueness is the keeper's registry to enforce (the daemon
 * `workspaces` table row / a browser IndexedDB registry row) — this schema
 * pins shape only.
 *
 * The charset reuses `DOCUMENT_PATH_SEGMENT_PATTERN` deliberately, for
 * consistency with document path segments (`documentPathSchema` above).
 *
 * The refinement below is the load-bearing invariant: workspace URLs
 * resolve segment-first with canonical-id fallback in ONE position, so a
 * segment must never itself be shaped like a ULID, or the two forms become
 * ambiguous there. The check is case-insensitive because Crockford base32
 * decodes without regard to case — `01arz...` names the same ULID as
 * `01ARZ...` — so rejecting only the uppercase form would leave the
 * lowercase spelling resolvable as a segment.
 */
export const workspaceSegmentSchema = z
  .string()
  .min(1)
  .regex(
    DOCUMENT_PATH_SEGMENT_PATTERN,
    'workspace segment must be ASCII letters, digits and interior hyphens',
  )
  .refine(
    (segment) => !ULID_PATTERN.test(segment.toUpperCase()),
    'workspace segment must not itself be shaped like a canonical ULID (reserved for the canonical-id URL fallback)',
  )

/**
 * A workspace's display name (ADR-0019): free text, no uniqueness, no
 * identity duties. Model has no equivalent schema for a document's display
 * name today (a document's name is workspace-tree metadata, not modelled
 * here), so this stays deliberately minimal: mirrors the one invariant the
 * daemon's names-store actually enforces on write — trimmed, non-empty
 * (empty-after-trim means "unset", stored as no value at all, not the empty
 * string) — rather than inventing a stronger rule nothing enforces today.
 */
export const workspaceDisplayNameSchema = z
  .string()
  .min(1)
  .refine(
    (name) => name === name.trim(),
    'workspace display name must not have leading/trailing whitespace',
  )

export type DocumentId = z.infer<typeof documentIdSchema>
export type DocumentPath = z.infer<typeof documentPathSchema>
export type NodeId = z.infer<typeof nodeIdSchema>
export type WorkspaceId = z.infer<typeof workspaceIdSchema>
export type WorkspaceCanonicalId = z.infer<typeof workspaceCanonicalIdSchema>
export type WorkspaceSegment = z.infer<typeof workspaceSegmentSchema>
export type WorkspaceDisplayName = z.infer<typeof workspaceDisplayNameSchema>
