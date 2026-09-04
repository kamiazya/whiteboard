import { apiFetch } from '@kamiazya/whiteboard-mcp/api-client'
import {
  type BranchMeta,
  type BranchStatsResponse,
  branchMetaSchema,
  branchStatsResponseSchema,
  type CreateBranchRequest,
  createBranchResponseSchema,
  type DeleteBranchResponse,
  type DocumentBranchesState,
  deleteBranchResponseSchema,
  documentBranchesStateSchema,
  type MergeResponse,
  mergeResponseSchema,
  type RenameBranchResponse,
  renameBranchResponseSchema,
  type SetHeadResponse,
  setHeadResponseSchema,
  type VersionDocumentResponse,
  versionDocumentResponseSchema,
} from '@kamiazya/whiteboard-mcp/api-contracts'
import { ZodError } from 'zod'

export type { BranchMeta }
export type BranchesState = DocumentBranchesState
export type MergeResult = MergeResponse

/** A refusal the daemon answered with a status, kept so a caller can branch on it. */
export interface BranchApiError {
  status: number
  body: Record<string, unknown>
}

// ── URL builder ──
// Paths can contain "/", so always encode them.
export function buildBranchUrls(
  workspaceId: string,
  path: string,
): {
  list: string
  head: string
  deleteBranch: (name: string) => string
  stats: (name: string) => string
  merge: (source: string) => string
  branchDocument: (name: string) => string
} {
  const safePath = encodeURIComponent(path)
  const base = `/api/workspaces/${workspaceId}/documents/${safePath}`
  return {
    list: `${base}/branches`,
    head: `${base}/head`,
    deleteBranch: (name) => `${base}/branches/${encodeURIComponent(name)}`,
    stats: (name) => `${base}/branches/${encodeURIComponent(name)}/stats`,
    merge: (source) => `${base}/branches/${encodeURIComponent(source)}/merge`,
    branchDocument: (name) => `${base}/branches/${encodeURIComponent(name)}/document`,
  }
}

// documentBranchesStateSchema is the single source of truth for the envelope
// shape. Fall back to filtering the branches array per-item only when the
// envelope itself fails validation (e.g. a single rogue row breaks the whole
// array parse), so the BranchPicker keeps rendering the valid branches
// instead of dropping the entire response.
export function parseBranchesResponse(raw: unknown): BranchesState {
  if (!raw || typeof raw !== 'object') return { branches: [], head: 'main' }
  const envelope = documentBranchesStateSchema.safeParse(raw)
  if (envelope.success) {
    return {
      branches: envelope.data.branches,
      head: envelope.data.head.length > 0 ? envelope.data.head : 'main',
    }
  }
  const data = raw as { head?: unknown; branches?: unknown }
  const branches: BranchMeta[] = []
  if (Array.isArray(data.branches)) {
    for (const entry of data.branches) {
      const parsed = branchMetaSchema.safeParse(entry)
      if (parsed.success) branches.push(parsed.data)
    }
  }
  return {
    branches,
    head: typeof data.head === 'string' && data.head.length > 0 ? data.head : 'main',
  }
}

async function requireOk(res: Response): Promise<Response> {
  if (res.ok) return res
  let body: Record<string, unknown> = {}
  try {
    body = (await res.json()) as Record<string, unknown>
  } catch {
    /* Leave body empty if it cannot be parsed. */
  }
  const err: BranchApiError = { status: res.status, body }
  throw err
}

// A schema mismatch on a 200 response means the server shipped a shape that
// does not match the client's contract. Normalise into a structured error so
// callers never receive a raw ZodError whose instanceof-Error check would
// incorrectly signal a network / auth problem.
function safeParse<T>(schema: { parse: (v: unknown) => T }, value: unknown): T {
  try {
    return schema.parse(value)
  } catch (e) {
    if (e instanceof ZodError) {
      const err: BranchApiError = {
        status: 200,
        body: { error: 'contract_mismatch', issues: e.issues },
      }
      throw err
    }
    throw e
  }
}

// Imperative API helpers independent from React. `fetchFn` defaults to the
// same-origin apiFetch so every pre-existing caller (MergeDialog,
// WorkspaceTopBar) is unaffected; a daemon-paired caller passes the
// daemon-origin-aware fetch obtained from useDaemonApi() instead. Kept a
// plain function (not a hook) because it is also constructed outside React
// (branchesApi.test.ts) and inside a ref (see useBranches below).
export function branchesApi(workspaceId: string, path: string, fetchFn: typeof fetch = apiFetch) {
  const urls = buildBranchUrls(workspaceId, path)
  return {
    async list(): Promise<BranchesState> {
      const res = await requireOk(await fetchFn(urls.list))
      return parseBranchesResponse(await res.json())
    },
    async create(args: CreateBranchRequest): Promise<BranchMeta> {
      const res = await requireOk(
        await fetchFn(urls.list, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(args),
        }),
      )
      return safeParse(createBranchResponseSchema, await res.json()).branch
    },
    async getStats(name: string): Promise<BranchStatsResponse> {
      const res = await requireOk(await fetchFn(urls.stats(name)))
      return safeParse(branchStatsResponseSchema, await res.json())
    },
    async remove(name: string): Promise<DeleteBranchResponse> {
      const res = await requireOk(await fetchFn(urls.deleteBranch(name), { method: 'DELETE' }))
      return safeParse(deleteBranchResponseSchema, await res.json())
    },
    async rename(oldName: string, newName: string): Promise<RenameBranchResponse> {
      const res = await requireOk(
        await fetchFn(urls.deleteBranch(oldName), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: newName }),
        }),
      )
      return safeParse(renameBranchResponseSchema, await res.json())
    },
    async setHead(branch: string): Promise<SetHeadResponse> {
      const res = await requireOk(
        await fetchFn(urls.head, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ branch }),
        }),
      )
      return safeParse(setHeadResponseSchema, await res.json())
    },
    // One variation's content at its tip, read-only — what ?v=<name> draws.
    // null when the branch (or its tip) is gone: the caller shows "variation
    // not found" and falls back to the live document.
    async loadDocument(name: string): Promise<VersionDocumentResponse | null> {
      const res = await fetchFn(urls.branchDocument(name))
      if (res.status === 404) return null
      await requireOk(res)
      return safeParse(versionDocumentResponseSchema, await res.json())
    },
    async merge(source: string, args: { into: string; dryRun?: boolean }): Promise<MergeResult> {
      const res = await requireOk(
        await fetchFn(urls.merge(source), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            into: args.into,
            dryRun: args.dryRun ?? false,
          }),
        }),
      )
      return safeParse(mergeResponseSchema, await res.json())
    },
  }
}

/**
 * A document's branches as the UI reads and writes them — the seam between
 * the branch chip, the merge banner and the history panel's mini-graph, and
 * whoever KEEPS the workspace.
 *
 * Unlike `VersionsBackend`, the two keepers here are not near-peers: the
 * daemon has branches and the browser has none, which `provider.ts` already
 * declares as a capability. So this seam is not how that difference gets
 * decided — it is how the difference stops being enforced by REMEMBERING.
 *
 * Before it, `useBranches` built the daemon's document route as a template
 * string and called `apiFetch`, gated by an `enabled` flag that defaults to
 * ON. (Named in words rather than written out: `web-api-paths-mounted` scans
 * apps/web for API path literals WITHOUT skipping comments, so a pseudo-path
 * in prose reaches it as a route the daemon fails to mount — including, when
 * this comment first tried to explain that, the fragment it quoted.)
 * Three consumers; one passed the flag. The other two were saved by where
 * they are mounted — a `branchesEnabled &&` in the top bar, and living only
 * on the daemon page — which is a property of today's tree rather than
 * anything a compiler could hold. A fourth consumer that forgot would fall
 * toward issuing the request.
 *
 * With a keeper-shaped backend the safe answer is the DEFAULT: forgetting
 * yields the resting state, not a request to a daemon that is not there.
 */
export interface BranchesBackend {
  /**
   * Whether this keeper has branches at all — declared by the backend rather
   * than passed by each caller.
   *
   * It replaces an `enabled` flag that `useBranches` took as an argument,
   * which is the same fact in the place least able to hold it: three
   * consumers, one of which passed it, and a default of ON. A keeper knows
   * this about itself and cannot forget to mention it.
   *
   * Consumers use it for the resting presentation — a panel whose keeper has
   * no branches must not spin waiting for a list that will be empty — and NOT
   * as permission to skip `list`, which answers correctly either way.
   */
  readonly hasBranches: boolean
  list(workspaceId: string, path: string): Promise<BranchesState>
  create(workspaceId: string, path: string, args: CreateBranchRequest): Promise<BranchMeta>
  remove(workspaceId: string, path: string, name: string): Promise<DeleteBranchResponse>
  rename(
    workspaceId: string,
    path: string,
    oldName: string,
    newName: string,
  ): Promise<RenameBranchResponse>
  setHead(workspaceId: string, path: string, branch: string): Promise<SetHeadResponse>
  getStats(workspaceId: string, path: string, name: string): Promise<BranchStatsResponse>
  merge(
    workspaceId: string,
    path: string,
    source: string,
    args: { into: string; dryRun?: boolean },
  ): Promise<MergeResponse>
  /**
   * One variation's content at its tip, read-only. `null` means the variation
   * is not there — which is the whole truth for a keeper that has none, and
   * the answer its caller already handles by falling back to the live
   * document. A refusal would be worse: the caller would have to learn a
   * second way to say the same thing.
   */
  loadDocument(
    workspaceId: string,
    path: string,
    name: string,
  ): Promise<VersionDocumentResponse | null>
}

/**
 * A keeper was asked for something it does not have.
 *
 * Typed rather than a bare `Error` so a caller can tell it from the
 * structured `{ status, body }` a daemon refusal throws: one means "this
 * keeper cannot do that at all", the other "the daemon said no this time".
 * Conflating them is how a permanent absence gets a retry button.
 */
export class BranchesUnsupportedError extends Error {
  constructor(what: string) {
    super(`this keeper has no branches: ${what}`)
    this.name = 'BranchesUnsupportedError'
  }
}

/** The daemon's branches, over its document routes. */
export function createDaemonBranchesBackend(fetchFn: typeof globalThis.fetch): BranchesBackend {
  // `branchesApi` is per-document, so each method builds its own. It is a
  // stateless wrapper over URL construction; the hook already rebuilt it on
  // every dependency change for the same reason.
  const api = (workspaceId: string, path: string) => branchesApi(workspaceId, path, fetchFn)
  return {
    hasBranches: true,
    list: (workspaceId, path) => api(workspaceId, path).list(),
    create: (workspaceId, path, args) => api(workspaceId, path).create(args),
    remove: (workspaceId, path, name) => api(workspaceId, path).remove(name),
    rename: (workspaceId, path, oldName, newName) =>
      api(workspaceId, path).rename(oldName, newName),
    setHead: (workspaceId, path, branch) => api(workspaceId, path).setHead(branch),
    getStats: (workspaceId, path, name) => api(workspaceId, path).getStats(name),
    merge: (workspaceId, path, source, args) => api(workspaceId, path).merge(source, args),
    loadDocument: (workspaceId, path, name) => api(workspaceId, path).loadDocument(name),
  }
}

/**
 * The browser keeper, which has no branches.
 *
 * `list` answers the RESTING STATE rather than throwing, because a panel that
 * reads `head` to draw its mini-graph wants an answer, not an error to log
 * and ignore. The mutators refuse, because a caller that got here is offering
 * an action this keeper cannot perform and silently succeeding would be worse
 * than saying so.
 */
export function createBrowserBranchesBackend(): BranchesBackend {
  const refuse = (what: string) => Promise.reject(new BranchesUnsupportedError(what))
  return {
    hasBranches: false,
    list: () => Promise.resolve({ branches: [], head: 'main' }),
    create: () => refuse('create'),
    remove: () => refuse('delete'),
    rename: () => refuse('rename'),
    setHead: () => refuse('switch'),
    getStats: () => refuse('stats'),
    merge: () => refuse('merge'),
    loadDocument: () => Promise.resolve(null),
  }
}
