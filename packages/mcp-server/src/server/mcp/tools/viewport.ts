import { z } from 'zod'
import {
  viewportErrorBodySchema,
  viewportResponseSchema,
} from '../../../shared/api-contracts/canvas-runtime.js'
import type { DaemonClient } from '../daemon-client.js'
import { parseCanvasId } from './canvas-id.js'

export { viewportResponseSchema as viewportSetOutputSchema }

export const viewportSetInputShape = {
  canvasId: z
    .string()
    .describe('Canvas ID in "{workspaceId}/{slug}" form. Browser must be connected.'),
  mode: z
    .enum(['fit', 'move'])
    .optional()
    .describe(
      '"fit" = scrollToContent + auto-zoom to frame the target elements. "move" = absolute scrollX/scrollY/zoom set. Default "fit".',
    ),
  elementIds: z
    .array(z.string())
    .optional()
    .describe(
      'Target element ids for mode="fit". When omitted, fit-to-all-elements. Ignored in "move" mode.',
    ),
  padding: z
    .number()
    .optional()
    .describe('Padding (px) around target bounding box for mode="fit". Default 40.'),
  animate: z
    .boolean()
    .optional()
    .describe('Animate the viewport transition. Default true. Only applies to mode="fit".'),
  scrollX: z.number().optional().describe('Absolute scrollX (world coords) for mode="move".'),
  scrollY: z.number().optional().describe('Absolute scrollY (world coords) for mode="move".'),
  zoom: z.number().optional().describe('Absolute zoom (1.0 = 100%) for mode="move".'),
} satisfies z.ZodRawShape

// Thin wrapper from MCP -> Hono route -> WS -> browser (excalidrawAPI).
// useWhiteboardSync handles the actual scroll/zoom application.
export function viewportSetTool() {
  return {
    name: 'viewport_set',
    description:
      'Pan/zoom the browser canvas to focus attention. Use mode="fit" to frame specific elements (or all elements when elementIds is omitted), or mode="move" to set scrollX/scrollY/zoom directly. Requires an open browser client — call canvas_open first.',
    // Derived from the Zod shape so the JSON-Schema view can never drift from
    // what registerToolWithAnnotations actually validates against.
    inputSchema: z.toJSONSchema(z.object(viewportSetInputShape)) as {
      type: 'object'
      properties: Record<string, unknown>
      required?: string[]
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
    ): Promise<z.infer<typeof viewportResponseSchema>> => {
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

      const res = await client.request(
        `/api/canvas/${workspaceId}/${encodeURIComponent(slug)}/viewport`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      )
      if (!res.ok) {
        const raw = await res.json().catch(() => null)
        const errParse = raw === null ? null : viewportErrorBodySchema.safeParse(raw)
        const errBody = errParse?.success ? errParse.data : null
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
      return viewportResponseSchema.parse(await res.json())
    },
  }
}
