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
 * The most characters an id a caller CHOOSES may have when it is written — a
 * node's, an edge's, a line's, a comment's, a thread's, a proposal's or a
 * change's. Minted ids are 21 (nanoid) to 26 (ULID) characters, so 256 holds
 * any id a person or an agent picks on purpose.
 *
 * An id is not free text: it is a key in the record, it is repeated in every
 * answer that names its element (measured: one node with a 1 Mi-character id
 * made a `wb_canvas_edit` answer 2 MB, and three edges to it 4 MB), and a
 * thread's or a proposal's id names a container of its own, which
 * `CONTAINER_NAME_MAX_CHARS` bounds. The stored shapes stay unbounded: an
 * element written before the limit must still read and still take an edit.
 */
export const ID_MAX_CHARS = 256

/** The id bound as every refusal of it ends, as `NODE_TEXT_LIMIT_PHRASE` is for a node's text. */
export const ID_LIMIT_PHRASE = `the ${ID_MAX_CHARS}-character limit for one id`

/** A node's, edge's or line's id as a tool accepts it for an element it creates. */
export const nodeIdInputSchema = nodeIdSchema.max(
  ID_MAX_CHARS,
  `an id is longer than ${ID_LIMIT_PHRASE}`,
)

/**
 * The longest name a sync write may give a container it brings into a
 * record, in UTF-16 code units.
 *
 * Loro writes a root container's name whole into every snapshot, and a
 * mergeable child — a comment thread, a proposal and the maps inside them —
 * is a root named by its parent and its key. Measured on loro-crdt 1.13.6: a
 * snapshot holding a name of 65,531 UTF-8 bytes imports and one byte more
 * does not, while the updates that wrote it still do — so one such write is
 * kept, and every document of the workspace is unreadable from the next
 * load on. A UTF-16 unit is at most three UTF-8 bytes, so 1,024 sits far
 * inside that, and it holds the deepest name this codebase writes with ids at
 * `ID_MAX_CHARS` (a thread's messages: about 300).
 */
export const CONTAINER_NAME_MAX_CHARS = 1024

/** The container-name bound as every refusal of it ends. */
export const CONTAINER_NAME_LIMIT_PHRASE = `the ${CONTAINER_NAME_MAX_CHARS}-character limit for the name of one container; a thread or a proposal is named by its id`

/**
 * Legacy workspace identifier shape, retained for the live data both
 * keepers already hold on disk today (the daemon's `workspaces.id` column,
 * the browser's hard-coded `'local'`). This codifies the contract already
 * enforced at runtime by mcp-server's `validateWorkspaceId`, which imports
 * `WORKSPACE_ID_PATTERN` from here (`/^[a-zA-Z0-9_-]+$/`, non-empty): workspace ids are used directly as
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
export const WORKSPACE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/

export const workspaceIdSchema = z
  .string()
  .min(1)
  .regex(WORKSPACE_ID_PATTERN, 'workspace id must be a path-safe path ([a-zA-Z0-9_-]+)')

/**
 * One segment of a document path: ASCII letters and digits, hyphens only in
 * the interior. mcp-server's `validateDocumentPath` imports this pattern, so
 * the schema and the validator that explains a rejection cannot drift apart.
 * `.` is absent from the character class rather than merely unmatched, which
 * is what forecloses `..` traversal once segments are joined into a
 * filesystem-shaped path.
 */
export const DOCUMENT_PATH_SEGMENT_PATTERN = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/

/**
 * The longest document path a request may name, separators included. A path
 * travels in a URL, and Node refuses a request line past about 16 KiB, so a
 * path the schema admitted past that could be stored and then never addressed
 * over HTTP; 1024 is far past any hierarchy a person types and well inside it.
 */
export const DOCUMENT_PATH_MAX_LENGTH = 1024

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
  .max(DOCUMENT_PATH_MAX_LENGTH)
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
 * shape. This is the only key references, versions, storage rows,
 * and sync ever use — never shown as chrome, never typed by a human.
 */
export const workspaceCanonicalIdSchema = z.string().regex(ULID_PATTERN, 'must be a canonical ULID')

/**
 * The longest workspace display name a request may carry, and the longest
 * segment. They are one number because a segment is DERIVED from a name
 * (`deriveWorkspaceSegment` replaces each run of characters with one hyphen, so
 * never lengthens it): a name the schema admits then always yields a segment
 * the segment schema admits. 200 holds any title a person writes and keeps a
 * workspace list a screen can show; a name past it was a paste, not a name.
 */
export const WORKSPACE_DISPLAY_NAME_MAX_LENGTH = 200
export const WORKSPACE_SEGMENT_MAX_LENGTH = 200

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
  .max(WORKSPACE_SEGMENT_MAX_LENGTH)
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
 * identity duties. Deliberately minimal: mirrors the one invariant the
 * daemon's names-store actually enforces on write — trimmed, non-empty
 * (empty-after-trim means "unset", stored as no value at all, not the empty
 * string) — rather than inventing a stronger rule nothing enforces today.
 */
export const workspaceDisplayNameSchema = z
  .string()
  .min(1)
  .max(WORKSPACE_DISPLAY_NAME_MAX_LENGTH)
  .refine(
    (name) => name === name.trim(),
    'workspace display name must not have leading/trailing whitespace',
  )

/**
 * The longest document display name a write may carry. A sibling of
 * `WORKSPACE_DISPLAY_NAME_MAX_LENGTH` rather than the same constant: that one
 * is also bound to the segment derived from it, and a document's name derives
 * nothing. The number is the same for the same reason — 200 holds any title a
 * person writes, and a name past it was a paste, not a name.
 */
export const DOCUMENT_NAME_MAX_LENGTH = 200

/**
 * A document's display name as a WRITE carries it. Only the length is checked:
 * the blank that clears a name and the trimming are each writer's existing
 * contract, and a name stored before the bound must still list, so readers do
 * not take this schema.
 */
export const documentNameSchema = z
  .string()
  .max(DOCUMENT_NAME_MAX_LENGTH, `a display name is at most ${DOCUMENT_NAME_MAX_LENGTH} characters`)

export type DocumentId = z.infer<typeof documentIdSchema>
export type NodeId = z.infer<typeof nodeIdSchema>
export type WorkspaceId = z.infer<typeof workspaceIdSchema>
