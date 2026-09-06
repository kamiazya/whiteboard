// @vitest-environment node
/**
 * The branches contract, run against every keeper the seam has.
 *
 * The daemon keeper's CLIENT runs against an in-memory stand-in for its
 * routes. What that proves and what it does not, said plainly (the same
 * caveat `versions-backend.contract.browser.test.tsx` carries): the daemon's
 * real branch behaviour — tips recorded against the workspace record, the
 * compaction pin, merge as tip adoption — is pinned where it lives, in
 * `mcp-node`, against the real routes and the real store. What is untested
 * anywhere else, and is exactly what this run adds, is that the client half
 * translates faithfully: that `create` sends the colour and reads the row
 * back out of the response, that `setHead` reports the head it left, that
 * `loadDocument` turns a 404 into `null` rather than a throw.
 *
 * The browser keeper has no branches yet and runs the branchless half.
 */
import type { BranchMeta } from '@kamiazya/whiteboard-daemon-client/api-contracts/index'
import { describe } from 'vitest'
import {
  type BranchesBackendHarness,
  branchesBackendContract,
} from './branches-backend.contract.js'
import { createDaemonBranchesBackend } from './branches-backend.js'

function daemonHarness(): BranchesBackendHarness {
  const main: BranchMeta = {
    name: 'main',
    tipFrontiers: '',
    color: '#888',
    createdAt: '2026-01-01T00:00:00.000Z',
  }
  const branches: BranchMeta[] = [main]
  let head = 'main'

  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  const bodyOf = (init?: RequestInit): Record<string, unknown> =>
    typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {}
  const named = (segment: string): string => decodeURIComponent(segment)

  const routes = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const method = init?.method ?? 'GET'

    const stats = url.match(/\/branches\/([^/]+)\/stats$/)
    if (stats) {
      const name = named(stats[1] as string)
      if (!branches.some((b) => b.name === name)) return json({ error: 'not_found' }, 404)
      return json({ unmergedCommits: 0, isHead: head === name })
    }

    const merge = url.match(/\/branches\/([^/]+)\/merge$/)
    if (merge && method === 'POST') {
      const source = named(merge[1] as string)
      const { into, dryRun } = bodyOf(init) as { into: string; dryRun?: boolean }
      if (!branches.some((b) => b.name === source) || !branches.some((b) => b.name === into)) {
        return json({ error: 'not_found' }, 404)
      }
      const counts = { elementCount: 0 }
      return json({
        badges: [],
        preview: counts,
        target: counts,
        source: counts,
        ...(dryRun === true ? {} : { committed: counts }),
      })
    }

    const documentRoute = url.match(/\/branches\/([^/]+)\/document$/)
    if (documentRoute) {
      const name = named(documentRoute[1] as string)
      if (!branches.some((b) => b.name === name)) return json({ error: 'not_found' }, 404)
      return json({ kind: 'spatial', canvas: { nodes: [], edges: [] } })
    }

    if (url.endsWith('/head') && method === 'PUT') {
      const { branch } = bodyOf(init) as { branch: string }
      if (!branches.some((b) => b.name === branch)) return json({ error: 'not_found' }, 404)
      const previousHead = head
      head = branch
      return json({ head, previousHead })
    }

    const one = url.match(/\/branches\/([^/]+)$/)
    if (one) {
      const name = named(one[1] as string)
      const at = branches.findIndex((b) => b.name === name)
      if (at === -1) return json({ error: 'not_found' }, 404)
      if (method === 'DELETE') {
        branches.splice(at, 1)
        return json({ ok: true, unmergedCommits: 0 })
      }
      if (method === 'PATCH') {
        const next = bodyOf(init) as { name: string }
        const renamed = { ...(branches[at] as BranchMeta), name: next.name }
        branches[at] = renamed
        if (head === name) head = next.name
        return json({ branch: renamed, renamedVersionCount: 0 })
      }
    }

    if (url.endsWith('/branches')) {
      if (method === 'POST') {
        const args = bodyOf(init) as { name: string; color?: string }
        const made: BranchMeta = {
          name: args.name,
          tipFrontiers: '',
          baseBranch: head,
          color: args.color ?? '#123',
          createdAt: '2026-01-02T00:00:00.000Z',
        }
        branches.push(made)
        return json({ branch: made })
      }
      return json({ branches, head })
    }

    return json({ error: `unrouted ${method} ${url}` }, 500)
  }

  return {
    backend: createDaemonBranchesBackend(routes as typeof fetch),
    workspaceId: 'w1',
    path: 'notes/canvas-a',
    cleanup: async () => {},
  }
}

describe('branches contract', () => {
  describe('daemon keeper (client over an in-memory stand-in for its routes)', () => {
    branchesBackendContract(daemonHarness)
  })

  // The browser keeper's run is `branches-backend.contract.browser.test.tsx`:
  // it IS its storage, so it needs a real record rather than a stand-in.
})
