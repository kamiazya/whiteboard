import { readFile } from 'node:fs/promises'
import { LoroDoc, LoroMap } from 'loro-crdt'
import { nanoid } from 'nanoid'
import { imageSize } from 'image-size'
import { z } from 'zod'
import type { DaemonClient } from '../daemon-client.js'
import { parseCanvasId } from './canvas-id.js'

export const loadImageOutputSchema = z.object({ elementId: z.string() })

// Infer the MIME type for an image file.
function getMimeType(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
  }
  return map[ext] ?? 'image/png'
}

// Fetch the Loro snapshot from the server.
async function apiGetSnapshot(
  client: DaemonClient,
  workspaceId: string,
  slug: string,
): Promise<LoroDoc> {
  const res = await client.request(
    `/api/canvas/${workspaceId}/${encodeURIComponent(slug)}/snapshot`,
  )
  if (!res.ok) throw new Error(`GET /snapshot failed: ${res.status}`)
  const bytes = new Uint8Array(await res.arrayBuffer())
  return LoroDoc.fromSnapshot(bytes)
}

// Send a binary Loro update to the server.
async function apiPostLoroUpdate(
  client: DaemonClient,
  workspaceId: string,
  slug: string,
  update: Uint8Array,
): Promise<void> {
  const res = await client.request(
    `/api/canvas/${workspaceId}/${encodeURIComponent(slug)}/update`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: update,
    },
  )
  if (!res.ok) throw new Error(`POST /update failed: ${res.status}`)
}

export const loadImageInputShape = {
  canvasId: z.string().describe('Canvas ID in "{workspaceId}/{slug}" form.'),
  imagePath: z
    .string()
    .describe(
      'Absolute path to a local image file (PNG / JPEG / GIF / WEBP / SVG). Image is uploaded to the canvas file store and inserted as an Excalidraw image element.',
    ),
  position: z
    .enum(['center', 'left', 'right'])
    .optional()
    .describe(
      'Where to place the image relative to the existing canvas content. Default "center".',
    ),
} satisfies z.ZodRawShape

export function loadImageTool() {
  return {
    name: 'load_image',
    description: 'Load an image file onto the whiteboard canvas',
    inputSchema: {
      type: 'object' as const,
      properties: {
        canvasId: { type: 'string', description: 'Canvas ID (workspaceId/slug)' },
        imagePath: { type: 'string', description: 'Absolute path to the image file' },
        position: {
          type: 'string',
          enum: ['center', 'left', 'right'],
          description: 'Position of the image on the canvas',
        },
      },
      required: ['canvasId', 'imagePath'],
    },
    execute: async (
      args: { canvasId: string; imagePath: string; position?: string },
      client: DaemonClient,
    ): Promise<z.infer<typeof loadImageOutputSchema>> => {
      const { workspaceId, slug } = parseCanvasId(args.canvasId)
      const position = args.position ?? 'center'

      // 1. Read the image file.
      const buffer = await readFile(args.imagePath)

      // 2. Read the image dimensions.
      const dimensions = imageSize(buffer)
      const width = dimensions.width ?? 800
      const height = dimensions.height ?? 600

      // 3. Generate ids.
      const elementId = nanoid()
      const fileId = nanoid()

      // 4. Compute the x coordinate from the requested position.
      let x: number
      if (position === 'left') {
        x = -(width + 40)
      } else if (position === 'right') {
        x = 40
      } else {
        x = 0 // center
      }

      // 5. Fetch the latest snapshot from the server.
      const doc = await apiGetSnapshot(client, workspaceId, slug)
      // fromSnapshot generates a random peerId automatically; do not call setPeerId.
      const prevVV = doc.version()

      // 6. Append the image element to the Loro list.
      const list = doc.getMovableList('elements')
      const map = list.insertContainer(list.length, new LoroMap())
      map.set('id', elementId)
      map.set('type', 'image')
      map.set('x', x)
      map.set('y', 0)
      map.set('width', width)
      map.set('height', height)
      map.set('fileId', fileId)
      map.set('status', 'loaded')
      map.set('angle', 0)
      map.set('opacity', 100)
      map.set('isDeleted', false)
      map.set('version', 1)
      map.set('versionNonce', Math.floor(Math.random() * 1000000))
      map.set('seed', Math.floor(Math.random() * 1000000))
      map.set('roughness', 0)
      map.set('roundness', null)
      map.set('strokeColor', 'transparent')
      map.set('backgroundColor', 'transparent')
      map.set('fillStyle', 'solid')
      map.set('strokeWidth', 1)
      map.set('strokeStyle', 'solid')
      // Required by Excalidraw: if these fields are missing, updateScene can throw
      // inside HC (for example on U.groupIds.length), which unmounts the React tree
      // and leaves the canvas blank.
      map.set('groupIds', [])
      map.set('boundElements', null)
      map.set('frameId', null)
      map.set('link', null)
      map.set('locked', false)
      map.set('updated', Date.now())
      // Image-specific fields.
      map.set('scale', [1, 1])
      map.set('crop', null)

      // 7. Upload the image bytes via REST before sending the update.
      // Do not run this in parallel: if the update arrives first, the browser can fetch /file/:fileId before the upload exists and hit 404.
      const mimeType = getMimeType(args.imagePath)
      const uploadRes = await client.request(
        `/api/canvas/${workspaceId}/${encodeURIComponent(slug)}/file/${fileId}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': mimeType },
          body: buffer,
        },
      )
      if (!uploadRes.ok) throw new Error(`PUT /file failed: ${uploadRes.status}`)

      // 8. commit
      doc.commit()

      // 9. Export the incremental update and POST it to /update.
      const update = doc.export({ mode: 'update', from: prevVV })
      await apiPostLoroUpdate(client, workspaceId, slug, update)

      return { elementId }
    },
  }
}
