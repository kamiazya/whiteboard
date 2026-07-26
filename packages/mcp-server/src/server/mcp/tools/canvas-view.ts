import { LoroDoc } from 'loro-crdt'
import { z } from 'zod'
import { loadCanvasFiles } from '../../export/load-canvas-files.js'
import type { DaemonClient } from '../daemon-client.js'
import { parseCanvasId } from './canvas-id.js'

// Scene shape mirrors packages/canvas-viewer's viewerSceneSchema
// ({elements, appState?, files?}, .strict()) so the widget's
// parseViewerScene accepts this structuredContent verbatim — no adapter
// layer between this tool and the widget. appState is omitted (undefined,
// not present) because the daemon's Loro document only persists the
// elements list; the widget falls back to its own defaults. `files` IS
// populated below — an image element only carries a `fileId` (the binary
// lives on disk, see load_image), so without it the widget would render
// broken/unresolved images for any canvas containing one.
const canvasViewFileSchema = z.object({
  mimeType: z.string(),
  id: z.string(),
  dataURL: z.string(),
  created: z.number(),
})

// OpenCanvas migration: the Excalidraw raw-element schema was removed. Elements
// are passed through as opaque records; the viewer widget's parseViewerScene is
// the strict boundary that validates their shape.
const canvasViewSceneSchema = z
  .object({
    elements: z.array(z.record(z.string(), z.unknown())),
    files: z.record(z.string(), canvasViewFileSchema),
  })
  .strict()

export const canvasViewOutputSchema = z.object({
  canvasId: z.string(),
  scene: canvasViewSceneSchema,
})

export const canvasViewInputShape = {
  canvasId: z
    .string()
    .describe(
      'Canvas ID in "{workspaceId}/{slug}" form. Returns a read-only scene snapshot (elements only, no daemon credentials) rendered as an interactive canvas view inline in the chat.',
    ),
} satisfies z.ZodRawShape

export function canvasViewTool() {
  return {
    name: 'canvas_view',
    description:
      'Render a read-only, interactive view of a whiteboard canvas inline in the chat (MCP Apps ui:// widget). Returns the current scene snapshot; the widget can pan/zoom/select but never mutates the canvas or receives daemon credentials.',
    inputSchema: z.toJSONSchema(z.object(canvasViewInputShape)) as {
      type: 'object'
      properties: Record<string, unknown>
      required?: string[]
    },
    execute: async (
      args: { canvasId: string },
      client: DaemonClient,
    ): Promise<z.infer<typeof canvasViewOutputSchema>> => {
      const { workspaceId, slug } = parseCanvasId(args.canvasId)
      const res = await client.request(
        `/api/canvas/${workspaceId}/${encodeURIComponent(slug)}/snapshot`,
      )
      if (!res.ok) {
        throw new Error(`Failed to fetch snapshot: ${res.status} ${res.statusText}`)
      }
      const bytes = new Uint8Array(await res.arrayBuffer())
      const doc = new LoroDoc()
      doc.import(bytes)
      const raw = doc.getMovableList('elements').toJSON() as Array<Record<string, unknown>>
      const elements = raw.filter((el) => el.isDeleted !== true)

      // Mirror headless-export.ts's buildExportScene: image elements only
      // carry a fileId, so the referenced binaries must be loaded and
      // embedded as dataURLs — the sandboxed widget has no daemon access
      // to fetch them itself.
      const referencedFileIds = new Set<string>()
      for (const el of elements as Array<Record<string, unknown>>) {
        if (el.type !== 'image') continue
        const fileId = el.fileId
        if (typeof fileId === 'string' && fileId.length > 0) referencedFileIds.add(fileId)
      }
      const files = await loadCanvasFiles(workspaceId, referencedFileIds)

      return { canvasId: args.canvasId, scene: { elements, files } }
    },
  }
}
