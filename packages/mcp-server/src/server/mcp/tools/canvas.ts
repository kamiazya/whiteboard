import open from 'open'
import { z } from 'zod'
import { clientCountResponseSchema } from '../../../shared/api-contracts/canvas-runtime.js'
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

// Loro op-log compaction result. Reasons mirror canvas-store.compactCanvas,
// kept as a free-form string here so a future server-side reason does not
// have to go through a schema bump in lockstep.
export const optimizeCanvasesOutputSchema = z.object({
  results: z.array(
    z.object({
      slug: z.string(),
      compacted: z.boolean(),
      beforeBytes: z.number().int().nonnegative(),
      afterBytes: z.number().int().nonnegative(),
      reason: z.string().optional(),
    }),
  ),
  totalBeforeBytes: z.number().int().nonnegative(),
  totalAfterBytes: z.number().int().nonnegative(),
})

interface WorkspaceSummary {
  workspaceId: string
}

interface CanvasSummary {
  slug: string
  updatedAt: string
}

export const canvasCreateInputShape = {
  slug: z
    .string()
    .describe(
      'URL-safe canvas slug (a-z, 0-9, hyphen). Used as the canvas identifier within the current workspace. Returned canvasId is "{workspaceId}/{slug}".',
    ),
  overwrite: z
    .boolean()
    .optional()
    .describe(
      'When true, replace an existing canvas with the same slug. Default false — existing slug throws ConflictError.',
    ),
} satisfies z.ZodRawShape

export function createCanvasTool() {
  return {
    name: 'canvas_create',
    description: 'Create a new whiteboard canvas',
    inputSchema: {
      type: 'object' as const,
      properties: {
        slug: { type: 'string', description: 'Canvas identifier (kebab-case)' },
        overwrite: {
          type: 'boolean',
          description:
            'When true, replace an existing canvas with the same slug. Default false — existing canvas causes a ConflictError.',
        },
      },
      required: ['slug'],
    },
    execute: async (
      args: { slug: string; overwrite?: boolean },
      workspaceId: string,
      client: DaemonClient,
    ): Promise<z.infer<typeof canvasCreateOutputSchema>> => {
      const res = await client.request(`/api/workspaces/${workspaceId}/canvases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: args.slug, overwrite: args.overwrite ?? false }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null
        throw new Error(body?.message ?? `Failed to create canvas: ${res.status}`)
      }
      const url = daemonUrl(client, `/canvas/${workspaceId}/${args.slug}`)
      return { id: `${workspaceId}/${args.slug}`, url }
    },
  }
}

export const canvasListInputShape = {
  slugContains: z
    .string()
    .optional()
    .describe(
      'Case-insensitive substring filter on canvas slug. Workspaces with 0 matching canvases are omitted from the output to reduce noise.',
    ),
} satisfies z.ZodRawShape

export function listCanvasTool() {
  return {
    name: 'canvas_list',
    description:
      'List whiteboard canvases. Optional filters narrow the output when multiple workspaces / canvases pile up.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        slugContains: {
          type: 'string',
          description:
            'Case-insensitive substring filter on canvas slug. Workspaces with 0 matching canvases are omitted from the output.',
        },
      },
    },
    execute: async (
      args: { slugContains?: string },
      client: DaemonClient,
    ): Promise<z.infer<typeof canvasListOutputSchema>> => {
      const res = await client.request('/api/workspaces')
      if (!res.ok) {
        throw new Error(`Failed to list workspaces: ${res.status}`)
      }
      const workspaces = ((await res.json()) as { workspaces: WorkspaceSummary[] }).workspaces
      const needle = args.slugContains?.toLowerCase()
      const result = await Promise.all(
        workspaces.map(async (workspace) => {
          const workspaceId = workspace.workspaceId
          const canvasesRes = await client.request(`/api/workspaces/${workspaceId}/canvases`)
          if (!canvasesRes.ok) {
            throw new Error(
              `Failed to list canvases for workspace ${workspaceId}: ${canvasesRes.status}`,
            )
          }
          let canvases = ((await canvasesRes.json()) as { canvases: CanvasSummary[] }).canvases
          if (needle) canvases = canvases.filter((c) => c.slug.toLowerCase().includes(needle))
          return {
            workspaceId,
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

export const canvasOpenInputShape = {
  id: z
    .string()
    .describe(
      'Canvas ID in "{workspaceId}/{slug}" form (returned by canvas_create / canvas_list).',
    ),
  fullscreen: z
    .boolean()
    .optional()
    .describe(
      'Open in fullscreen editing mode (sidebar hidden, Excalidraw fills viewport). User can toggle with sidebar button or "f" / Escape. Default false.',
    ),
  waitForClient: z
    .boolean()
    .optional()
    .describe(
      'Block until the browser establishes a WebSocket connection. Prevents no_client errors when chaining canvas_open → export_png / viewport_set. Default false.',
    ),
  waitTimeoutMs: z
    .number()
    .optional()
    .describe(
      'Polling timeout (ms) for waitForClient. Default 5000. Ignored when waitForClient is false.',
    ),
} satisfies z.ZodRawShape

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
    ): Promise<z.infer<typeof canvasOpenOutputSchema>> => {
      // Use a URL hash, not a query string, for fullscreen so callers can
      // re-open the same canvas to toggle fullscreen without triggering a
      // browser navigation. Fragment-only changes fire `hashchange` on the
      // already-open tab; the page never reloads, in-page state is
      // preserved, and Playwright's `browser_navigate` does not surface a
      // leave-confirmation dialog. CanvasPage reads both `#fullscreen` and
      // the legacy `?fullscreen=1` on mount.
      const fragment = args.fullscreen ? '#fullscreen' : ''
      const url = daemonUrl(client, `/canvas/${args.id}${fragment}`)
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
            const parsed = clientCountResponseSchema.safeParse(await res.json())
            if (parsed.success && (parsed.data.readyCount ?? parsed.data.count) > 0) {
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

// Compact Loro op-log via shallow-snapshot. Single tool, two modes:
//   • slug provided  → compact one canvas, return it as a 1-element results
//   • slug omitted   → compact every canvas in the workspace, return per-canvas
//                      array + aggregated totals
// Both call into the same server-side compactCanvas() so cut-point semantics
// (oldest retained version frontiers) and idempotency stay identical.
export const optimizeCanvasesInputShape = {
  slug: z
    .string()
    .optional()
    .describe(
      'Canvas slug to optimize. When omitted, every canvas in the current workspace is compacted in sequence.',
    ),
} satisfies z.ZodRawShape

export function optimizeCanvasesTool() {
  return {
    name: 'optimize_canvases',
    description:
      'Compact Loro op-log history (shallow-snapshot) on one canvas (slug given) or every canvas in the current workspace (slug omitted). Idempotent — returns reason "no-versions" / "no-gain" / "ok" per canvas.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        slug: {
          type: 'string',
          description:
            'Optional canvas slug. When omitted, every canvas in the current workspace is compacted in sequence.',
        },
      },
    },
    execute: async (
      args: { slug?: string },
      workspaceId: string,
      client: DaemonClient,
    ): Promise<z.infer<typeof optimizeCanvasesOutputSchema>> => {
      if (args.slug) {
        const slug = args.slug
        const res = await client.request(
          `/api/workspaces/${workspaceId}/canvases/${encodeURIComponent(slug)}/compact`,
          { method: 'POST' },
        )
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { message?: string } | null
          throw new Error(body?.message ?? `optimize failed: ${res.status}`)
        }
        const single = (await res.json()) as {
          compacted: boolean
          beforeBytes: number
          afterBytes: number
          reason?: string
        }
        return {
          results: [{ slug, ...single }],
          totalBeforeBytes: single.beforeBytes,
          totalAfterBytes: single.afterBytes,
        }
      }
      const res = await client.request(`/api/workspaces/${workspaceId}/canvases/optimize-all`, {
        method: 'POST',
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null
        throw new Error(body?.message ?? `optimize-all failed: ${res.status}`)
      }
      return (await res.json()) as z.infer<typeof optimizeCanvasesOutputSchema>
    },
  }
}
