import { apiFetch } from '@kamiazya/whiteboard-mcp/api-client'
import {
  type BranchMeta,
  type BranchStatsResponse,
  branchMetaSchema,
  branchStatsResponseSchema,
  type CanvasBranchesState,
  type CreateBranchRequest,
  canvasBranchesStateSchema,
  createBranchResponseSchema,
  type DeleteBranchResponse,
  deleteBranchResponseSchema,
  type MergeResponse,
  mergeResponseSchema,
  type RenameBranchResponse,
  renameBranchResponseSchema,
  type SetHeadResponse,
  setHeadResponseSchema,
} from '@kamiazya/whiteboard-mcp/api-contracts'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ZodError } from 'zod'

// Branch API helpers plus the React hook wrapper.
// - branchesApi: pure request helpers that can be tested without React.
// - useBranches: bundles list state and mutators. Callers notify the hook of
//   an external HEAD change (e.g. useCanvasSync's onHeadChanged) by invoking
//   the returned `refetch`; this hook does not subscribe to any event bus.

export type { BranchMeta }
export type BranchesState = CanvasBranchesState
export type MergeResult = MergeResponse

// ── URL builder ──
// Slugs can contain "/", so always encode them.
export function buildBranchUrls(
  workspaceId: string,
  slug: string,
): {
  list: string
  head: string
  deleteBranch: (name: string) => string
  stats: (name: string) => string
  merge: (source: string) => string
} {
  const safeSlug = encodeURIComponent(slug)
  const base = `/api/workspaces/${workspaceId}/canvases/${safeSlug}`
  return {
    list: `${base}/branches`,
    head: `${base}/head`,
    deleteBranch: (name) => `${base}/branches/${encodeURIComponent(name)}`,
    stats: (name) => `${base}/branches/${encodeURIComponent(name)}/stats`,
    merge: (source) => `${base}/branches/${encodeURIComponent(source)}/merge`,
  }
}

// canvasBranchesStateSchema is the single source of truth for the envelope
// shape. Fall back to filtering the branches array per-item only when the
// envelope itself fails validation (e.g. a single rogue row breaks the whole
// array parse), so the BranchPicker keeps rendering the valid branches
// instead of dropping the entire response.
export function parseBranchesResponse(raw: unknown): BranchesState {
  if (!raw || typeof raw !== 'object') return { branches: [], head: 'main' }
  const envelope = canvasBranchesStateSchema.safeParse(raw)
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

// Throw structured HTTP errors so callers can branch on status and body.
export interface BranchApiError {
  status: number
  body: Record<string, unknown>
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

// Imperative API helpers independent from React.
export function branchesApi(workspaceId: string, slug: string) {
  const urls = buildBranchUrls(workspaceId, slug)
  return {
    async list(): Promise<BranchesState> {
      const res = await requireOk(await apiFetch(urls.list))
      return parseBranchesResponse(await res.json())
    },
    async create(args: CreateBranchRequest): Promise<BranchMeta> {
      const res = await requireOk(
        await apiFetch(urls.list, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(args),
        }),
      )
      return safeParse(createBranchResponseSchema, await res.json()).branch
    },
    async getStats(name: string): Promise<BranchStatsResponse> {
      const res = await requireOk(await apiFetch(urls.stats(name)))
      return safeParse(branchStatsResponseSchema, await res.json())
    },
    async remove(name: string): Promise<DeleteBranchResponse> {
      const res = await requireOk(await apiFetch(urls.deleteBranch(name), { method: 'DELETE' }))
      return safeParse(deleteBranchResponseSchema, await res.json())
    },
    async rename(oldName: string, newName: string): Promise<RenameBranchResponse> {
      const res = await requireOk(
        await apiFetch(urls.deleteBranch(oldName), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: newName }),
        }),
      )
      return safeParse(renameBranchResponseSchema, await res.json())
    },
    async setHead(branch: string): Promise<SetHeadResponse> {
      const res = await requireOk(
        await apiFetch(urls.head, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ branch }),
        }),
      )
      return safeParse(setHeadResponseSchema, await res.json())
    },
    async merge(source: string, args: { into: string; dryRun?: boolean }): Promise<MergeResult> {
      const res = await requireOk(
        await apiFetch(urls.merge(source), {
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

// React hook.
// Expose refetch so callers can refresh on an externally observed HEAD
// change (e.g. useCanvasSync's onHeadChanged callback).
export interface UseBranchesResult {
  state: BranchesState
  loading: boolean
  error: BranchApiError | Error | null
  refetch: () => Promise<void>
  createBranch: (args: CreateBranchRequest) => Promise<BranchMeta>
  deleteBranch: (name: string) => Promise<void>
  getBranchStats: (name: string) => Promise<BranchStatsResponse>
  renameBranch: (oldName: string, newName: string) => Promise<BranchMeta>
  setHead: (branch: string) => Promise<SetHeadResponse>
  merge: (source: string, args: { into: string; dryRun?: boolean }) => Promise<MergeResult>
}

export function useBranches(workspaceId: string, slug: string): UseBranchesResult {
  const [state, setState] = useState<BranchesState>({ branches: [], head: 'main' })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<BranchApiError | Error | null>(null)
  const apiRef = useRef(branchesApi(workspaceId, slug))
  // Monotonically increasing counter. Each refetch call stamps its result with
  // the counter value at dispatch time; the setter is a no-op when a newer
  // fetch has already committed. This prevents a slower in-flight response
  // from overwriting the result of a later refetch.
  const fetchSeqRef = useRef(0)

  // Recreate the API wrapper whenever session or slug changes.
  useEffect(() => {
    apiRef.current = branchesApi(workspaceId, slug)
  }, [workspaceId, slug])

  const refetch = useCallback(async () => {
    const seq = ++fetchSeqRef.current
    setLoading(true)
    try {
      const next = await apiRef.current.list()
      if (seq !== fetchSeqRef.current) return
      setState(next)
      setError(null)
    } catch (err) {
      if (seq !== fetchSeqRef.current) return
      setError(err as BranchApiError | Error)
    } finally {
      if (seq === fetchSeqRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refetch()
  }, [refetch, workspaceId, slug])

  // Bump the sequence counter on unmount so any in-flight fetch resolution is
  // routed into the stale-fetch guard above instead of committing state after
  // the component is gone. There is no window-event subscription here: the
  // caller (e.g. CanvasPage via useCanvasSync's onHeadChanged option) invokes
  // `refetch` directly when it observes an external HEAD change.
  useEffect(() => {
    return () => {
      fetchSeqRef.current++
    }
  }, [])

  const createBranch = useCallback(
    async (args: CreateBranchRequest) => {
      const branch = await apiRef.current.create(args)
      await refetch()
      return branch
    },
    [refetch],
  )

  const deleteBranch = useCallback(
    async (name: string) => {
      await apiRef.current.remove(name)
      await refetch()
    },
    [refetch],
  )

  const getBranchStats = useCallback(async (name: string) => apiRef.current.getStats(name), [])

  const renameBranch = useCallback(
    async (oldName: string, newName: string) => {
      const { branch } = await apiRef.current.rename(oldName, newName)
      await refetch()
      return branch
    },
    [refetch],
  )

  const setHead = useCallback(
    async (branch: string) => {
      const result = await apiRef.current.setHead(branch)
      await refetch()
      return result
    },
    [refetch],
  )

  const merge = useCallback(
    async (source: string, args: { into: string; dryRun?: boolean }) => {
      const result = await apiRef.current.merge(source, args)
      if (!(args.dryRun ?? false)) await refetch()
      return result
    },
    [refetch],
  )

  return {
    state,
    loading,
    error,
    refetch,
    createBranch,
    deleteBranch,
    getBranchStats,
    renameBranch,
    setHead,
    merge,
  }
}
