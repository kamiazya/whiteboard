import {
  documentIdSchema,
  documentKindSchema,
  documentPathSchema,
  workspaceDisplayNameSchema,
  workspaceIdSchema,
  workspaceSegmentSchema,
} from '@kamiazya/whiteboard-model'
import { z } from 'zod'

export const documentEntrySchema = z
  .object({
    documentId: documentIdSchema,
    path: documentPathSchema,
    // Optional: a document created before kinds existed has a placement and
    // content but no recorded format. It must still LIST — hiding stored data
    // is the dishonest surface — and the read path is where "format unknown"
    // is said (wb_document_get refuses such a document with advice).
    // createDocument's input keeps `kind` required; only pre-kind rows lack it.
    kind: documentKindSchema.optional(),
    /**
     * What a human reads, as opposed to `path`, which is an address. Absent
     * rather than defaulted to the last path segment: a reader that wants
     * that fallback can choose it, while a listing that invents one reads as
     * though somebody typed the path in as a title.
     */
    name: z.string().min(1).optional(),
    /**
     * True when an earlier sibling owns this path — only reachable through
     * concurrent creation on two replicas, which no local uniqueness check
     * can prevent. Shown rather than hidden: the data has converged, and a
     * listing that dropped half of it would read as loss. `z.literal(true)`
     * so the absent case has exactly one spelling.
     */
    shadowed: z.literal(true).optional(),
    /**
     * When the placement last changed, ISO 8601.
     *
     * OPTIONAL because an index may genuinely not own it: a tree entry
     * written before timestamps landed in the node meta has none, and an
     * invented timestamp is worse than an absent one because it reads as
     * fact. Every UI site that renders it already treats absence as "no age
     * to show".
     */
    updatedAt: z.string().optional(),
  })
  .strict()
export type DocumentEntry = z.infer<typeof documentEntrySchema>

export const createDocumentInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    path: documentPathSchema,
    kind: documentKindSchema,
    name: z.string().min(1).optional(),
  })
  .strict()
export type CreateDocumentInput = z.infer<typeof createDocumentInputSchema>

/**
 * ADR-0019's user-facing (`segment`) and naming (`displayName`) layers, both
 * optional: shape-validated here via the model schemas, but their PERSISTENCE
 * and — for `segment` — their per-keeper UNIQUENESS are the registry
 * implementation's job, not this contract's. An implementation is free to
 * accept and currently ignore both fields — the conformance suite's base
 * case stays satisfiable that way, which is what apps/web's browser registry
 * and the in-memory double still rely on. mcp-server's daemon
 * (`CacheCoherentDocumentIndex`) is the first implementation that actually
 * PERSISTS and SERVES them: the `workspaces` table carries a `segment`
 * column with a unique index (a collision throws
 * `WorkspaceSegmentTakenError`, below), and `workspaceSummarySchema` serves
 * both fields through the published `@kamiazya/whiteboard-mcp/api-contracts`
 * subpath.
 *
 * No `canonicalId` field: ADR-0019's canonical layer already IS
 * `workspaceId`. Its schema tightens from `workspaceIdSchema` to the
 * stricter `workspaceCanonicalIdSchema` only after both keepers' minting
 * migrations land (tightening first would reject live data such as
 * `'default'`/`'local'`) — a separate `canonicalId` field would just be a
 * second spelling of the same layer racing that migration.
 */
export const createWorkspaceInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    segment: workspaceSegmentSchema.optional(),
    displayName: workspaceDisplayNameSchema.optional(),
  })
  .strict()
export type CreateWorkspaceInput = z.infer<typeof createWorkspaceInputSchema>

/**
 * A `listWorkspaces` row. `segment`/`displayName` are OPTIONAL for the same
 * reason `DocumentEntry`'s `name` is: a workspace created before ADR-0019's
 * minting migration lands has neither, and an invented value would read as
 * fact where there is none.
 */
export const workspaceEntrySchema = z
  .object({
    workspaceId: workspaceIdSchema,
    segment: workspaceSegmentSchema.optional(),
    displayName: workspaceDisplayNameSchema.optional(),
  })
  .strict()
export type WorkspaceEntry = z.infer<typeof workspaceEntrySchema>

/**
 * Turns an incoming address string into the workspace it names: `segment`
 * first, then `workspaceId`, else null.
 *
 * The ONE definition of that order. Every surface that accepts a handle — an
 * HTTP path parameter, a WS target, an MCP tool argument — shares a single
 * namespace between ADR-0019's canonical and user-facing layers, so a rule
 * spelled out per surface is a rule that will eventually be spelled
 * differently at one of them.
 *
 * Segment wins the one collision that can arise. It cannot happen against a
 * CANONICAL id, since `workspaceSegmentSchema` structurally forbids a
 * ULID-shaped segment, but a LEGACY id is any `[a-zA-Z0-9_-]+` string and can
 * equal somebody's segment. The segment is what a human chose on purpose; the
 * shadowed workspace stays reachable by its own id.
 *
 * Total, and never turns a handle away for its SHAPE: the daemon's live ids
 * include `default` and nanoid-minted strings carrying `_`, none of which are
 * valid segments, and all of which must still resolve.
 */
export function resolveWorkspaceHandle(
  entries: readonly WorkspaceEntry[],
  handle: string,
): WorkspaceEntry | null {
  return (
    entries.find((entry) => entry.segment === handle) ??
    entries.find((entry) => entry.workspaceId === handle) ??
    null
  )
}

/**
 * A rename of ADR-0019's two CHOSEN layers. The canonical `workspaceId` is
 * not among them — it is what everything keys on, and a rename that moved it
 * would be a different workspace wearing the same name.
 *
 * Each field ABSENT means "leave this layer as it is", not "clear it". The
 * two are renamed through one call because a form edits them together, and
 * the destructive reading — a display-name edit that silently drops the
 * address — is the one a caller would never intend. There is deliberately no
 * way to clear a layer back to absent: absent is a state a workspace arrives
 * in (a legacy row, a display name whose script the segment charset cannot
 * spell), not one anybody has asked to return to.
 */
export const renameWorkspaceInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    segment: workspaceSegmentSchema.optional(),
    displayName: workspaceDisplayNameSchema.optional(),
  })
  .strict()
export type RenameWorkspaceInput = z.infer<typeof renameWorkspaceInputSchema>

export const resolveDocumentByIdInputSchema = z
  .object({ workspaceId: workspaceIdSchema, documentId: documentIdSchema })
  .strict()
export type ResolveDocumentByIdInput = z.infer<typeof resolveDocumentByIdInputSchema>

export const resolveDocumentInputSchema = z
  .object({ workspaceId: workspaceIdSchema, path: documentPathSchema })
  .strict()
export type ResolveDocumentInput = z.infer<typeof resolveDocumentInputSchema>

export const listDocumentsInputSchema = z.object({ workspaceId: workspaceIdSchema }).strict()
export type ListDocumentsInput = z.infer<typeof listDocumentsInputSchema>

export const moveDocumentInputSchema = z
  .object({ workspaceId: workspaceIdSchema, from: documentPathSchema, to: documentPathSchema })
  .strict()
export type MoveDocumentInput = z.infer<typeof moveDocumentInputSchema>

export const setDocumentNameInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    documentId: documentIdSchema,
    name: z.string().min(1).optional(),
  })
  .strict()
export type SetDocumentNameInput = z.infer<typeof setDocumentNameInputSchema>

export const deleteDocumentInputSchema = z
  .object({ workspaceId: workspaceIdSchema, path: documentPathSchema })
  .strict()
export type DeleteDocumentInput = z.infer<typeof deleteDocumentInputSchema>

/**
 * The `listDocuments` order, as a function, so two implementations cannot
 * write it two ways. Compares segment against segment by code point, and a
 * path sorts before every path it prefixes.
 *
 * A pure model-only helper in a contracts package for the same reason
 * `chunkSnapshot` is one: the rule is part of the contract, and a comparator
 * every store re-derives from prose is a comparator they will re-derive
 * differently.
 */
export function compareDocumentPaths(left: string, right: string): number {
  const a = left.split('/')
  const b = right.split('/')
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const segmentA = a[i] as string
    const segmentB = b[i] as string
    if (segmentA !== segmentB) return segmentA < segmentB ? -1 : 1
  }
  return a.length - b.length
}

/**
 * Thrown when an operation names a workspace that does not exist.
 *
 * Workspaces never materialize implicitly here. A typo'd or hallucinated
 * workspaceId is otherwise indistinguishable from a new one, and the caller
 * gets a workspace nobody asked for with its data quietly inside.
 */
/**
 * Cross-realm-safe guard for `WorkspaceNotFoundError`. `instanceof` alone is
 * a trap here: this class reaches a consumer through more than one module
 * graph (a bundler inlining one package while externalizing another, vitest
 * transforming a workspace dependency a `vi.mock`ing test file pulls in),
 * and two loads of this file make two class identities that `instanceof`
 * refuses to relate. The name check is what survives that — measured: a
 * route's `instanceof` answered false for an error whose constructor name
 * matched exactly.
 */
export function isWorkspaceNotFoundError(error: unknown): error is WorkspaceNotFoundError {
  return (
    error instanceof WorkspaceNotFoundError ||
    (error instanceof Error && error.name === 'WorkspaceNotFoundError')
  )
}

export class WorkspaceNotFoundError extends Error {
  constructor(readonly workspaceId: string) {
    super(`Workspace not found: "${workspaceId}". Create it before adding documents to it.`)
    this.name = 'WorkspaceNotFoundError'
  }
}

/**
 * Thrown when a path the caller wanted to occupy is already occupied.
 *
 * Named in the contract rather than left to each implementation: "fails if the
 * path is taken" is not a guarantee a caller can act on if one store throws
 * this and another surfaces whatever its unique index raised. A store whose
 * backing has no unique constraint has to detect the collision itself, and
 * only a named error makes that difference visible instead of silent.
 */
export class DocumentPathTakenError extends Error {
  constructor(
    readonly workspaceId: string,
    readonly path: string,
  ) {
    super(`Document path "${path}" already exists in workspace "${workspaceId}"`)
    this.name = 'DocumentPathTakenError'
  }
}

/**
 * Cross-realm-safe guard for `WorkspaceSegmentTakenError`, on the same
 * reasoning as `isWorkspaceNotFoundError` above.
 */
export function isWorkspaceSegmentTakenError(error: unknown): error is WorkspaceSegmentTakenError {
  return (
    error instanceof WorkspaceSegmentTakenError ||
    (error instanceof Error && error.name === 'WorkspaceSegmentTakenError')
  )
}

/**
 * Thrown when a `createWorkspace` segment (ADR-0019's user-facing layer) is
 * already held by another workspace in the same keeper's registry.
 *
 * A registry-level refusal, not a `DocumentPathTakenError`-shaped collision:
 * a segment names a WORKSPACE, not a document inside one, and uniqueness is
 * enforced by whichever registry persists it (mcp-server's `workspaces`
 * table, today) rather than by this contract.
 */
export class WorkspaceSegmentTakenError extends Error {
  constructor(readonly segment: string) {
    super(`Workspace segment "${segment}" is already taken`)
    this.name = 'WorkspaceSegmentTakenError'
  }
}

/**
 * Thrown when resolution BY PATH names a path that more than one document
 * carries — reachable only through concurrent creation on two replicas.
 * The listing shows both (one `shadowed`); resolving the ambiguity is the
 * caller's decision, made by id or by renaming one, never by this port
 * silently picking whichever sibling tree order favors.
 */
export class DocumentPathContestedError extends Error {
  constructor(
    readonly workspaceId: string,
    readonly path: string,
  ) {
    super(
      `More than one document carries "${path}" in workspace "${workspaceId}". ` +
        'Resolve by documentId, or rename one of them.',
    )
    this.name = 'DocumentPathContestedError'
  }
}

/**
 * Thrown when an operation names a document that is not there. Deleting an
 * absent path is deliberately NOT this — the caller wanted it gone and it is —
 * but moving one is: there is a destination involved, and silently doing
 * nothing would look identical to having moved it.
 */
export class DocumentNotFoundError extends Error {
  constructor(
    readonly workspaceId: string,
    /** The path or the id the caller named — whichever the operation takes. */
    readonly target: string,
  ) {
    super(`No document "${target}" in workspace "${workspaceId}"`)
    this.name = 'DocumentNotFoundError'
  }
}

/** Thrown when an operation would strand or swallow the documents below its target. */
export class DocumentHasDescendantsError extends Error {
  constructor(
    readonly path: string,
    detail: string,
  ) {
    super(`Document "${path}" has descendants. ${detail}`)
    this.name = 'DocumentHasDescendantsError'
  }
}

/** Thrown when a move's destination lies inside the subtree being moved. */
export class DocumentMoveIntoSelfError extends Error {
  constructor(
    readonly from: string,
    readonly to: string,
  ) {
    super(`Cannot move "${from}" to "${to}": the destination is inside the subtree being moved`)
    this.name = 'DocumentMoveIntoSelfError'
  }
}

/**
 * The workspace's index of the documents it holds: which paths exist, what
 * each one is, and which stored document each names.
 *
 * It is deliberately separate from `DocumentStore`, which owns a single
 * document's bytes and knows nothing about where that document sits. This
 * one owns placement and is the only thing that assigns a `documentId`.
 *
 * **Mutating operations are serialized per workspace, and each takes effect as
 * one indivisible operation or has no effect at all.** Path uniqueness is the
 * entire mechanism enforcing sibling uniqueness here, so an implementation
 * that checks a path and then writes it as two separable steps can satisfy
 * this interface and still produce duplicates, and one that rewrites a subtree
 * without the same guarantee can leave a hierarchy half moved. Neither is
 * observable through the types, which is why it is stated — and stated as
 * serialization rather than as bare "atomicity", which would leave the
 * observable ordering to each implementation and make the guarantee untestable.
 */
export interface DocumentIndex {
  /**
   * Idempotent: creating a workspace that exists is not an error, because the
   * caller wants it to be there and it is. Explicit because `createDocument`
   * refuses an absent workspace rather than conjuring one.
   */
  createWorkspace(input: CreateWorkspaceInput): Promise<void>
  /**
   * Every workspace this index holds, INCLUDING the ones with no documents in
   * them: a workspace is a real, addressable place before anything is put in
   * it, and hiding the empty ones would make a freshly created one look like
   * it failed.
   *
   * Answers rather than throwing when there are no documents yet — unlike
   * `listDocuments`, there is no id here that could have been a typo, so
   * "none" is an answer rather than an ambiguity. Note this does NOT promise
   * the list is empty on a fresh index: apps/web writes its one workspace
   * when its store is created, because that is the one the browser UI opens.
   */
  listWorkspaces(): Promise<WorkspaceEntry[]>
  /**
   * The workspace an incoming ADDRESS names — `segment` first, then
   * `workspaceId` — or null when nothing answers to it.
   *
   * Separate from `listWorkspaces` because a caller holding a handle should
   * not have to know the resolution order to use it; `resolveWorkspaceHandle`
   * above is the single definition, and every implementation is expected to
   * delegate to it rather than restate the order.
   *
   * Required, not optional. An optional method is one a surface can forget to
   * call, and forgetting means falling back to a literal id match — which is
   * indistinguishable from working until the day a segment exists.
   */
  resolveWorkspace(handle: string): Promise<WorkspaceEntry | null>
  /**
   * Renames the layers their owner chooses — `segment`, `displayName`, or
   * both — and answers the workspace as it now stands, so a caller that has
   * just moved an ADDRESS does not have to re-list to learn the handle it
   * should be using.
   *
   * Fails `WorkspaceNotFoundError` for a workspace that does not exist:
   * unlike `createWorkspace` there is nothing to be idempotent about, and a
   * rename that quietly created what it was asked to rename would put a
   * typo'd id in the registry wearing the name meant for something else.
   *
   * Fails `WorkspaceSegmentTakenError` when ANOTHER workspace in this
   * keeper's registry holds the segment, and refuses as one operation — the
   * workspace keeps the address it had rather than ending up with neither.
   * The workspace's OWN current segment is accepted, because a form that
   * submits every field would otherwise refuse to save a display-name edit
   * by reporting the workspace's own address as taken.
   */
  renameWorkspace(input: RenameWorkspaceInput): Promise<WorkspaceEntry>
  /**
   * Fails `WorkspaceNotFoundError` if the workspace does not exist. Fails if
   * the path is taken. Creating never silently adopts an existing
   * document, because the caller that wanted a new one would otherwise
   * start writing into somebody else's. Claiming the path and assigning the
   * `documentId` is one step, not a check followed by a write.
   */
  createDocument(input: CreateDocumentInput): Promise<DocumentEntry>
  resolveDocument(input: ResolveDocumentInput): Promise<DocumentEntry | null>
  /**
   * The same lookup keyed by the id the index assigned. Still workspace-scoped:
   * an id is a handle within a workspace, not a capability that reaches across
   * them, so the wrong workspace resolves to null rather than to the document.
   */
  resolveDocumentById(input: ResolveDocumentByIdInput): Promise<DocumentEntry | null>
  /**
   * Fails `WorkspaceNotFoundError` for a workspace that does not exist,
   * rather than answering with an empty list. A typo'd workspaceId is
   * otherwise indistinguishable from a workspace that genuinely holds
   * nothing, and the caller most likely to hit it is a listing.
   *
   * Ordered by path, compared SEGMENT BY SEGMENT — not as whole strings.
   * A hierarchical listing is the point of this index, and leaving the order
   * to whatever a store's rows come back in would put a storage detail in
   * front of a user.
   *
   * Which comparison is not a detail: `-` (0x2D) sorts before `/` (0x2F), so
   * comparing whole strings puts `a-b` between `a` and its own child `a/b`
   * and splits a subtree apart. Segment-wise gives `a`, `a/b`, `a-b`, keeping
   * every subtree contiguous, which is the only order a tree can be rendered
   * from without re-sorting.
   *
   * Segment-wise alone still leaves two choices, so both are fixed here:
   * segments compare by Unicode code point (`a/10` before `a/2`, since `1`
   * precedes `2` — NOT natural/numeric collation, which would reorder them
   * and is locale-shaped), and a path sorts before every path it prefixes
   * (`x` before `x/y`). Descendants-first would also keep subtrees
   * contiguous, so it has to be ruled out rather than left to the example.
   */
  listDocuments(input: ListDocumentsInput): Promise<DocumentEntry[]>
  /**
   * Moves a document, and with it every descendant — `a/b` moving to `c`
   * takes `a/b/d` to `c/d`, because a descendant's path is defined by its
   * ancestors' and nothing else records the relationship.
   *
   * Fails if **any** path the move would produce is already taken, not only
   * `to` itself: moving `a` to `c` collides when `a/d` and `c/d` both exist
   * even though `c` is free. The move is rejected whole in that case — a
   * partial move would silently merge two hierarchies, and the caller asked
   * to relocate one.
   *
   * Fails when `from` names nothing — unlike a delete, which is content with
   * an absent path, a move has a destination and doing nothing quietly would
   * be indistinguishable from succeeding.
   *
   * Also fails when `to` is inside `from`'s own subtree (`a` to `a/b`). The
   * produced paths do not actually collide there — prefix replacement keeps
   * distinct suffixes distinct — so this is a deliberate refusal rather than
   * a consequence of the rule above: without it, whether the moving subtree's
   * own paths count as "taken" during its own move is left to each
   * implementation, and two of them would disagree observably.
   *
   * This is a real limitation, not a meaningless case being tidied away:
   * `a` to `a/archive` is a coherent "wrap this subtree in a new level"
   * reorganisation. It is refused because the exemption rule that would
   * permit it is intricate and nothing needs it yet. A restructuring flow
   * that wants it should get its own operation rather than an exception
   * carved into this one.
   */
  moveDocument(input: MoveDocumentInput): Promise<void>
  /**
   * Sets — or, with no `name`, clears — a document's display name. Keyed by
   * id rather than by path because a name is not a placement: renaming must
   * leave the document exactly where it is, and a caller that has to name the
   * path to change the name would eventually move one by accident.
   *
   * Fails `DocumentNotFoundError` for an id this workspace does not hold, on
   * the same reasoning as `moveDocument`: a rename has a target, and quietly
   * doing nothing is indistinguishable from having renamed it.
   */
  setDocumentName(input: SetDocumentNameInput): Promise<void>
  /**
   * Deleting an absent path succeeds; the caller wants it gone either way.
   *
   * Deleting one that still has descendants does NOT: every document here can
   * hold children, so a cascade is reachable from a single call naming one
   * path, and deletion is the operation with nothing to undo it. Refusing
   * makes the caller name what it is destroying. `moveDocument` carries
   * descendants precisely because a move loses nothing.
   */
  deleteDocument(input: DeleteDocumentInput): Promise<void>
}
