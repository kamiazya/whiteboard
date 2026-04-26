import open from 'open'
import { z } from 'zod'
import type { DaemonClient } from '../daemon-client.js'
import { daemonUrl } from '../daemon-client.js'

export const canvasCreateOutputSchema = z.object({
  id: z.string(),
  url: z.string(),
})

export const canvasListOutputSchema = z.object({
  workspaces: z.array(
    z.object({
      workspaceId: z.string(),
      daemonAlive: z.boolean(),
      canvases: z.array(
        z.object({
          id: z.string(),
          slug: z.string(),
          url: z.string(),
          updatedAt: z.string(),
        }),
      ),
    }),
  ),
})

export const canvasOpenOutputSchema = z.object({
  url: z.string(),
  clientReady: z.boolean().optional(),
  openFailed: z.string().optional(),
})

interface WorkspaceSummary {
  workspaceId: string
  daemonAlive: boolean
}

interface CanvasSummary {
  slug: string
  updatedAt: string
}

export function createCanvasTool() {
  return {
    name: 'canvas_create',
    description: 'Create a new whiteboard canvas',
    inputSchema: {
      type: 'object' as const,
      properties: {
        slug: { type: 'string', description: 'Canvas identifier (kebab-case)' },
        issueNumber: { type: 'number', description: 'GitHub issue number (optional prefix)' },
        overwrite: {
          type: 'boolean',
          description:
            'When true, replace an existing canvas with the same slug. Default false — existing canvas causes a ConflictError.',
        },
      },
      required: ['slug'],
    },
    execute: async (
      args: { slug: string; issueNumber?: number; overwrite?: boolean },
      workspaceId: string,
      client: DaemonClient,
    ) => {
      const finalSlug = args.issueNumber ? `${args.issueNumber}-${args.slug}` : args.slug
      const res = await client.request(`/api/workspaces/${workspaceId}/canvases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: finalSlug, overwrite: args.overwrite ?? false }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null
        throw new Error(body?.message ?? `Failed to create canvas: ${res.status}`)
      }
      const url = daemonUrl(client, `/canvas/${workspaceId}/${finalSlug}`)
      return { id: `${workspaceId}/${finalSlug}`, url }
    },
  }
}

export function listCanvasTool() {
  return {
    name: 'canvas_list',
    description:
      'List whiteboard canvases. Optional filters narrow the output when multiple workspaces / canvases pile up.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        activeOnly: {
          type: 'boolean',
          description:
            'Only return workspaces while the local Excalidraw daemon is currently alive. Default false.',
        },
        slugContains: {
          type: 'string',
          description:
            'Case-insensitive substring filter on canvas slug. Workspaces with 0 matching canvases are omitted from the output.',
        },
      },
    },
    execute: async (
      args: { activeOnly?: boolean; slugContains?: string },
      client: DaemonClient,
    ) => {
      const res = await client.request('/api/workspaces')
      if (!res.ok) {
        throw new Error(`Failed to list workspaces: ${res.status}`)
      }
      let workspaces = ((await res.json()) as { workspaces: WorkspaceSummary[] }).workspaces
      if (args.activeOnly) {
        workspaces = workspaces.filter((s) => s.daemonAlive === true)
      }
      const needle = args.slugContains?.toLowerCase()
      const result = await Promise.all(
        workspaces.map(async (workspace) => {
          const workspaceId = workspace.workspaceId
          const canvasesRes = await client.request(`/api/workspaces/${workspaceId}/canvases`)
          if (!canvasesRes.ok) {
            throw new Error(`Failed to list canvases for workspace ${workspaceId}: ${canvasesRes.status}`)
          }
          let canvases = ((await canvasesRes.json()) as { canvases: CanvasSummary[] }).canvases
          if (needle) canvases = canvases.filter((c) => c.slug.toLowerCase().includes(needle))
          return {
            workspaceId,
            daemonAlive: workspace.daemonAlive,
            canvases: canvases.map((c) => ({
              id: `${workspaceId}/${c.slug}`,
              slug: c.slug,
              url: daemonUrl(client, `/canvas/${workspaceId}/${c.slug}`),
              updatedAt: c.updatedAt,
            })),
          }
        }),
      )
      // When slugContains is set, hide workspaces with no matching canvases to reduce noise.
      const filtered = needle ? result.filter((s) => s.canvases.length > 0) : result
      return {
        workspaces: filtered,
      }
    },
  }
}

export function openCanvasTool() {
  return {
    name: 'canvas_open',
    description: 'Open a canvas in the browser',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Canvas ID (workspaceId/slug)' },
        fullscreen: {
          type: 'boolean',
          description:
            'Open the canvas in fullscreen editing mode (sidebar hidden, Excalidraw fills the viewport). User can toggle with the sidebar button or press "f" / Escape.',
        },
        waitForClient: {
          type: 'boolean',
          description:
            'Wait for the browser to connect via WebSocket before returning. Prevents no_client errors when chaining canvas_open → export_png / viewport_set. Default false.',
        },
        waitTimeoutMs: {
          type: 'number',
          description:
            'Timeout (ms) for waitForClient polling. Default 5000. Ignored when waitForClient is false.',
        },
      },
      required: ['id'],
    },
    execute: async (
      args: { id: string; fullscreen?: boolean; waitForClient?: boolean; waitTimeoutMs?: number },
      client: DaemonClient,
    ) => {
      const qs = args.fullscreen ? '?fullscreen=1' : ''
      const url = daemonUrl(client, `/canvas/${args.id}${qs}`)
      // Browser launch may fail silently in headless, sandboxed, or no-display
      // environments. We still return the URL, but also include openFailed so
      // callers can distinguish this from later no_client failures in higher-level tools.
      let openFailed: string | undefined
      try {
        await open(url)
      } catch (err) {
        openFailed = err instanceof Error ? err.message : String(err)
      }

      if (!args.waitForClient) {
        return openFailed ? { url, openFailed } : { url }
      }

      // Poll /api/canvas/:sid/:slug/client-count every 100ms until count >= 1 or timeout.
      // Build the URL with encodeURIComponent(slug) so nested slugs like "621/header" work.
      const [workspaceId, ...slugParts] = args.id.split('/')
      const slug = slugParts.join('/')
      const statusPath = `/api/canvas/${workspaceId}/${encodeURIComponent(slug)}/client-count`
      const deadline = Date.now() + (args.waitTimeoutMs ?? 5000)
      let clientReady = false
      while (Date.now() < deadline) {
        try {
          const res = await client.request(statusPath)
          if (res.ok) {
            const body = (await res.json()) as { count: number; readyCount?: number }
            if ((body.readyCount ?? body.count) > 0) {
              clientReady = true
              break
            }
          }
        } catch {
          // Allow brief Hono startup races and retry.
        }
        await new Promise((r) => setTimeout(r, 100))
      }
      return openFailed ? { url, clientReady, openFailed } : { url, clientReady }
    },
  }
}
