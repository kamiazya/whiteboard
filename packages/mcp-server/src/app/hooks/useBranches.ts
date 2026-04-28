import { useCallback, useEffect, useRef, useState } from 'react'
import {
  type BranchMeta,
  type BranchStatsResponse,
  type CanvasBranchesState,
  type CreateBranchRequest,
  type DeleteBranchResponse,
  type MergeResponse,
  type RenameBranchResponse,
  type SetHeadResponse,
  branchMetaSchema,
  branchStatsResponseSchema,
  createBranchResponseSchema,
  deleteBranchResponseSchema,
  mergeResponseSchema,
  renameBranchResponseSchema,
  setHeadResponseSchema,
} from '../../shared/api-contracts/branches.js'
import { apiFetch } from '../lib/api-client.js'

// Branch API helpers plus the React hook wrapper.
// - branchesApi: pure request helpers that can be tested without React.
// - useBranches: bundles list state and mutators, and refetches on head_changed events.

export type { BranchMeta }
export type BranchesState = CanvasBranchesState
export type MergeResult = MergeResponse

// ── URL builder ──
// Slugs can contain "/", so always encode them.
export function buildBranchUrls(workspaceId: string, slug: string): {
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

// Defensive parse: filter malformed entries per-item so the BranchPicker keeps
// rendering valid branches even if the server (or a stale cache) ships a rogue
// row. branchMetaSchema is the single source of truth for the wire shape.
export function parseBranchesResponse(raw: unknown): BranchesState {
  if (!raw || typeof raw !== 'object') return { branches: [], head: 'main' }
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
    head: typeof data.head === 'string' ? data.head : 'main',
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
      return createBranchResponseSchema.parse(await res.json()).branch
    },
    async getStats(name: string): Promise<BranchStatsResponse> {
      const res = await requireOk(await apiFetch(urls.stats(name)))
      return branchStatsResponseSchema.parse(await res.json())
    },
    async remove(name: string): Promise<DeleteBranchResponse> {
      const res = await requireOk(
        await apiFetch(urls.deleteBranch(name), { method: 'DELETE' }),
      )
      return deleteBranchResponseSchema.parse(await res.json())
    },
    async rename(oldName: string, newName: string): Promise<RenameBranchResponse> {
      const res = await requireOk(
        await apiFetch(urls.deleteBranch(oldName), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: newName }),
        }),
      )
      return renameBranchResponseSchema.parse(await res.json())
    },
    async setHead(branch: string): Promise<SetHeadResponse> {
      const res = await requireOk(
        await apiFetch(urls.head, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ branch }),
        }),
      )
      return setHeadResponseSchema.parse(await res.json())
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
      return mergeResponseSchema.parse(await res.json())
    },
  }
}

// React hook.
// Expose refetch so callers can refresh on head_changed websocket events.
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

  // Recreate the API wrapper whenever session or slug changes.
  useEffect(() => {
    apiRef.current = branchesApi(workspaceId, slug)
  }, [workspaceId, slug])

  const refetch = useCallback(async () => {
    setLoading(true)
    try {
      const next = await apiRef.current.list()
      setState(next)
      setError(null)
    } catch (err) {
      setError(err as BranchApiError | Error)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refetch()
  }, [refetch, workspaceId, slug])

  // useWhiteboardSync emits a window event when HEAD changes.
  // Refetch only for the matching session/slug pair.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ workspaceId: string; slug: string; head: string }>)
        .detail
      if (!detail) return
      if (detail.workspaceId !== workspaceId || detail.slug !== slug) return
      void refetch()
    }
    window.addEventListener('excalidraw:head_changed', handler)
    return () => window.removeEventListener('excalidraw:head_changed', handler)
  }, [refetch, workspaceId, slug])

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

  const getBranchStats = useCallback(
    async (name: string) => apiRef.current.getStats(name),
    [],
  )

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
