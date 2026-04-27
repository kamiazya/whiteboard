import { z } from 'zod'
import type { DaemonClient } from '../daemon-client.js'
import { parseCanvasId } from './canvas-id.js'

export const viewportSetOutputSchema = z.object({ ok: z.literal(true) })

// Thin wrapper from MCP -> Hono route -> WS -> browser (excalidrawAPI).
// useWhiteboardSync handles the actual scroll/zoom application.
export function viewportSetTool() {
  return {
    name: 'viewport_set',
    description:
      'Pan/zoom the browser canvas to focus attention. Use mode="fit" to frame specific elements (or all elements when elementIds is omitted), or mode="move" to set scrollX/scrollY/zoom directly. Requires an open browser client — call canvas_open first.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        canvasId: { type: 'string', description: 'Canvas ID (workspaceId/slug)' },
        mode: {
          type: 'string',
          enum: ['fit', 'move'],
          description:
            'Viewport update mode. Default: "fit". "fit" frames elementIds (or all elements). "move" sets scrollX/scrollY/zoom directly.',
        },
        elementIds: {
          type: 'array',
          items: { type: 'string' },
          description:
            '(mode="fit") Element IDs to frame. Omit to fit all elements in the scene.',
        },
        padding: {
          type: 'number',
          description: '(mode="fit") Extra padding in viewport pixels around the framed bounds.',
        },
        animate: {
          type: 'boolean',
          description:
            'Whether to animate the viewport transition. Default: true. Set false for instant snaps.',
        },
        scrollX: {
          type: 'number',
          description: '(mode="move") Target scrollX in scene coordinates.',
        },
        scrollY: {
          type: 'number',
          description: '(mode="move") Target scrollY in scene coordinates.',
        },
        zoom: {
          type: 'number',
          description: '(mode="move") Target zoom level (e.g. 1 = 100%, 2 = 200%).',
        },
      },
      required: ['canvasId'],
    },
    execute: async (
      args: {
        canvasId: string
        mode?: 'fit' | 'move'
        elementIds?: string[]
        padding?: number
        animate?: boolean
        scrollX?: number
        scrollY?: number
        zoom?: number
      },
      client: DaemonClient,
    ) => {
      const { workspaceId, slug } = parseCanvasId(args.canvasId)
      const mode = args.mode ?? 'fit'
      // Only send explicitly specified values so browser defaults still apply.
      const body: Record<string, unknown> = { mode }
      if (args.elementIds !== undefined) body.elementIds = args.elementIds
      if (args.padding !== undefined) body.padding = args.padding
      if (args.animate !== undefined) body.animate = args.animate
      if (args.scrollX !== undefined) body.scrollX = args.scrollX
      if (args.scrollY !== undefined) body.scrollY = args.scrollY
      if (args.zoom !== undefined) body.zoom = args.zoom

      const res = await client.request(`/api/canvas/${workspaceId}/${encodeURIComponent(slug)}/viewport`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const errBody = (await res.json().catch(() => null)) as
          | { error?: string; message?: string; hint?: string }
          | null
        if (errBody?.error === 'no_client') {
          throw new Error(
            `${errBody.message ?? 'No browser client connected.'}${errBody.hint ? ` Hint: ${errBody.hint}` : ''}`,
          )
        }
        if (errBody?.error === 'timeout') {
          throw new Error(errBody.message ?? 'Viewport update timed out.')
        }
        throw new Error(
          `Viewport update failed: ${res.status} ${errBody?.message ?? 'unknown error'}`,
        )
      }
      return (await res.json()) as { ok: true }
    },
  }
}
