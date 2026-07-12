import { z } from 'zod'
import {
  paletteResponseSchema,
  type PaletteEntries,
} from '../../../shared/api-contracts/palette.js'
import type { DaemonClient } from '../daemon-client.js'

export { paletteResponseSchema as paletteOutputSchema }

async function readPaletteResponse(res: Response, label: string): Promise<PaletteEntries> {
  if (!res.ok) throw new Error(`${label} failed: ${res.status}`)
  return paletteResponseSchema.parse(await res.json()).palette
}

export async function apiGetPalette(
  client: DaemonClient,
  workspaceId: string,
): Promise<PaletteEntries> {
  return readPaletteResponse(
    await client.request(`/api/workspaces/${workspaceId}/palette`),
    'GET /palette',
  )
}

export async function apiSetPalette(
  client: DaemonClient,
  workspaceId: string,
  entries: PaletteEntries,
): Promise<PaletteEntries> {
  return readPaletteResponse(
    await client.request(`/api/workspaces/${workspaceId}/palette`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries }),
    }),
    'PUT /palette',
  )
}

export async function apiDeletePalette(
  client: DaemonClient,
  workspaceId: string,
  keys: string[],
): Promise<PaletteEntries> {
  return readPaletteResponse(
    await client.request(`/api/workspaces/${workspaceId}/palette`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys }),
    }),
    'DELETE /palette',
  )
}

export const paletteGetInputShape = { workspaceId: z.string() } satisfies z.ZodRawShape

export function paletteGetTool() {
  return {
    name: 'palette_get',
    description:
      'Get the workspace color palette used by annotate / annotate_batch semantic tokens.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        workspaceId: { type: 'string' },
      },
      required: ['workspaceId'],
    },
    execute: async (
      args: { workspaceId: string },
      client: DaemonClient,
    ): Promise<z.infer<typeof paletteResponseSchema>> => {
      return { palette: await apiGetPalette(client, args.workspaceId) }
    },
  }
}

export const paletteSetInputShape = {
  workspaceId: z
    .string()
    .describe(
      'Workspace ID (the part before "/" in canvasId). Palette is shared across all canvases in the workspace.',
    ),
  entries: z
    .record(z.string(), z.string())
    .describe(
      'Color key → hex map. Keys are dotted semantic identifiers (e.g. "plan.a.bg", "accent.target"). Values are hex (#RRGGBB). Existing keys are merged (not replaced wholesale). Use these keys instead of hex in annotate/annotate_batch color/backgroundColor for re-themability.',
    ),
} satisfies z.ZodRawShape

export function paletteSetTool() {
  return {
    name: 'palette_set',
    description: 'Merge entries into the workspace color palette and return the resulting palette.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        workspaceId: { type: 'string' },
        entries: { type: 'object', additionalProperties: { type: 'string' } },
      },
      required: ['workspaceId', 'entries'],
    },
    execute: async (
      args: { workspaceId: string; entries: PaletteEntries },
      client: DaemonClient,
    ): Promise<z.infer<typeof paletteResponseSchema>> => {
      return { palette: await apiSetPalette(client, args.workspaceId, args.entries) }
    },
  }
}

export const paletteDeleteInputShape = {
  workspaceId: z.string(),
  keys: z.array(z.string()).min(1),
} satisfies z.ZodRawShape

export function paletteDeleteTool() {
  return {
    name: 'palette_delete',
    description: 'Delete keys from the workspace color palette and return the resulting palette.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        workspaceId: { type: 'string' },
        keys: { type: 'array', items: { type: 'string' }, minItems: 1 },
      },
      required: ['workspaceId', 'keys'],
    },
    execute: async (
      args: { workspaceId: string; keys: string[] },
      client: DaemonClient,
    ): Promise<z.infer<typeof paletteResponseSchema>> => {
      return { palette: await apiDeletePalette(client, args.workspaceId, args.keys) }
    },
  }
}
