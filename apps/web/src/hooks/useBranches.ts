import type {
  BranchStatsResponse,
  CreateBranchRequest,
  SetHeadResponse,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/index'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useBranchesBackend } from '@/contexts/BranchesBackendContext'
import type {
  BranchApiError,
  BranchesBackend,
  BranchesState,
  BranchMeta,
  MergeResult,
} from '@/lib/branches-backend'

// The React half. The transport half — URL building, response parsing, the
// structured error — moved to `lib/branches-backend.ts` when the seam landed,
// because leaving it here made the pair a value-import CYCLE: the context
// imports the backend, the backend imported this module for its request
// helpers, and this module imports the context. `repo-coverage` is what said
// so; it was a stylistic complaint until the guard named it.
// Callers notify the hook of an external HEAD change (e.g. useDocumentSync's
// onHeadChanged) by invoking the returned `refetch`; it subscribes to no
// event bus of its own.
export type { BranchesState, BranchMeta, MergeResult }

/**
 * The seam's methods take (workspaceId, path) per call; the hook holds one
 * document. Binding them once keeps the call sites below unchanged from when
 * this was a per-document `branchesApi`.
 */
function boundBranches(backend: BranchesBackend, workspaceId: string, path: string) {
  return {
    list: () => backend.list(workspaceId, path),
    create: (args: CreateBranchRequest) => backend.create(workspaceId, path, args),
    remove: (name: string) => backend.remove(workspaceId, path, name),
    rename: (oldName: string, newName: string) =>
      backend.rename(workspaceId, path, oldName, newName),
    setHead: (branch: string) => backend.setHead(workspaceId, path, branch),
    getStats: (name: string) => backend.getStats(workspaceId, path, name),
    merge: (source: string, args: { into: string; dryRun?: boolean }) =>
      backend.merge(workspaceId, path, source, args),
  }
}

// React hook.
// Expose refetch so callers can refresh on an externally observed HEAD
// change (e.g. useDocumentSync's onHeadChanged callback).
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

export function useBranches(workspaceId: string, path: string): UseBranchesResult {
  // WHICH keeper answers comes from context, not from an argument. It used to
  // be an `enabled` flag each caller passed, defaulting to ON — three callers,
  // one of which passed it, the other two saved by where they are mounted
  // rather than by anything a compiler could check. A keeper with no branches
  // now answers the resting state itself, so forgetting yields `main` instead
  // of a request to a daemon that is not there.
  const backend = useBranchesBackend()
  const enabled = backend.hasBranches
  const [state, setState] = useState<BranchesState>({ branches: [], head: 'main' })
  const [loading, setLoading] = useState(enabled)
  const [error, setError] = useState<BranchApiError | Error | null>(null)
  // Recreated synchronously during render (compare-and-update below) rather
  // than in an effect: refetch() reads apiRef.current, and an effect-based
  // rebuild would depend on effect declaration order to run before the
  // initial-fetch effect — correct today but fragile under reordering. The
  // factory is a stateless wrapper, so rebuilding during render is safe.
  const apiRef = useRef(boundBranches(backend, workspaceId, path))
  const apiDepsRef = useRef({ workspaceId, path, backend })
  if (
    apiDepsRef.current.workspaceId !== workspaceId ||
    apiDepsRef.current.path !== path ||
    apiDepsRef.current.backend !== backend
  ) {
    apiDepsRef.current = { workspaceId, path, backend }
    apiRef.current = boundBranches(backend, workspaceId, path)
  }
  // Monotonically increasing counter. Each refetch call stamps its result with
  // the counter value at dispatch time; the setter is a no-op when a newer
  // fetch has already committed. This prevents a slower in-flight response
  // from overwriting the result of a later refetch.
  const fetchSeqRef = useRef(0)

  // Reset synchronously during render when the canvas changes — an effect
  // would leave one frame where consumers that don't check `loading` see the
  // PREVIOUS canvas's branches/head.
  // A literal NUL as the separator, written as an escape: neither a workspace
  // id nor a document path can contain one, so the two halves cannot collide
  // the way a `/` or `:` separator would. Spelled `\0` because a raw NUL byte
  // in the source makes every tool treat this file as binary — grep reports
  // "binary file matches" and prints nothing, which is how a stale name in
  // here survived a repo-wide sweep.
  const documentKey = `${workspaceId}\0${path}`
  const [prevDocumentKey, setPrevDocumentKey] = useState(documentKey)
  if (prevDocumentKey !== documentKey) {
    setPrevDocumentKey(documentKey)
    setState({ branches: [], head: 'main' })
    setError(null)
    setLoading(enabled)
  }

  const refetch = useCallback(async () => {
    if (!enabled) return
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
  }, [enabled])

  useEffect(() => {
    void refetch()
  }, [refetch, workspaceId, path, backend])

  // Bump the sequence counter on unmount so any in-flight fetch resolution is
  // routed into the stale-fetch guard above instead of committing state after
  // the component is gone. There is no window-event subscription here: the
  // caller (e.g. DocumentPage via useDocumentSync's onHeadChanged option) invokes
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
