import type { DaemonClient } from '../daemon-client.js'

async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T
}

export async function apiGetPalette(
  client: DaemonClient,
  sessionId: string,
): Promise<Record<string, string>> {
  const res = await client.request(`/api/workspaces/${sessionId}/palette`)
  if (!res.ok) throw new Error(`GET /palette failed: ${res.status}`)
  const body = await readJson<{ palette?: Record<string, string> }>(res)
  return body.palette ?? {}
}

export async function apiSetPalette(
  client: DaemonClient,
  sessionId: string,
  entries: Record<string, string>,
): Promise<Record<string, string>> {
  const res = await client.request(`/api/workspaces/${sessionId}/palette`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entries }),
  })
  if (!res.ok) throw new Error(`PUT /palette failed: ${res.status}`)
  const body = await readJson<{ palette?: Record<string, string> }>(res)
  return body.palette ?? {}
}

export async function apiDeletePalette(
  client: DaemonClient,
  sessionId: string,
  keys: string[],
): Promise<Record<string, string>> {
  const res = await client.request(`/api/workspaces/${sessionId}/palette`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keys }),
  })
  if (!res.ok) throw new Error(`DELETE /palette failed: ${res.status}`)
  const body = await readJson<{ palette?: Record<string, string> }>(res)
  return body.palette ?? {}
}

export function paletteGetTool() {
  return {
    name: 'palette_get',
    description: 'Get the workspace color palette used by annotate / annotate_batch semantic tokens.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: { type: 'string' },
      },
      required: ['sessionId'],
    },
    execute: async (args: { sessionId: string }, client: DaemonClient) => {
      return { palette: await apiGetPalette(client, args.sessionId) }
    },
  }
}

export function paletteSetTool() {
  return {
    name: 'palette_set',
    description: 'Merge entries into the workspace color palette and return the resulting palette.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: { type: 'string' },
        entries: { type: 'object', additionalProperties: { type: 'string' } },
      },
      required: ['sessionId', 'entries'],
    },
    execute: async (
      args: { sessionId: string; entries: Record<string, string> },
      client: DaemonClient,
    ) => {
      return { palette: await apiSetPalette(client, args.sessionId, args.entries) }
    },
  }
}

export function paletteDeleteTool() {
  return {
    name: 'palette_delete',
    description: 'Delete keys from the workspace color palette and return the resulting palette.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: { type: 'string' },
        keys: { type: 'array', items: { type: 'string' }, minItems: 1 },
      },
      required: ['sessionId', 'keys'],
    },
    execute: async (args: { sessionId: string; keys: string[] }, client: DaemonClient) => {
      return { palette: await apiDeletePalette(client, args.sessionId, args.keys) }
    },
  }
}
