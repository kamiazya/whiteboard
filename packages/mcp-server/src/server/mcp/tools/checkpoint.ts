import { nanoid } from 'nanoid'
import type { DaemonClient } from '../daemon-client.js'
import { daemonUrl } from '../daemon-client.js'
import { parseCanvasId } from './canvas-id.js'
import { validateCheckpointId } from '../../store/checkpoint-store.js'

export function checkpointSaveTool() {
  return {
    name: 'checkpoint_save',
    description:
      'Save the current canvas state as a checkpoint for later restore. Returns a checkpointId. Checkpoints are globally scoped (session-independent), stored under DATA_DIR/.checkpoints/. Useful for branching off a diagram or reverting user edits.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        canvasId: { type: 'string', description: 'Canvas ID (workspaceId/slug) to snapshot.' },
        id: {
          type: 'string',
          description:
            'Optional checkpoint id (alphanumeric, hyphen, underscore, ≤64 chars). If omitted, a short nanoid is generated.',
        },
      },
      required: ['canvasId'],
    },
    execute: async (
      args: { canvasId: string; id?: string },
      client: DaemonClient,
    ): Promise<{ checkpointId: string; elementCount: number }> => {
      const { workspaceId, slug } = parseCanvasId(args.canvasId)
      const checkpointId = args.id ?? nanoid(18)
      validateCheckpointId(checkpointId)
      const res = await client.request(`/api/workspaces/${workspaceId}/checkpoints`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceSlug: slug,
          checkpointId,
        }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null
        throw new Error(body?.message ?? `Checkpoint save failed: ${res.status}`)
      }
      return (await res.json()) as { checkpointId: string; elementCount: number }
    },
  }
}

export function checkpointRestoreTool() {
  return {
    name: 'checkpoint_restore',
    description:
      'Restore a previously saved checkpoint into a canvas slug in the current workspace. Fails if the target slug already exists unless overwrite=true.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        checkpointId: {
          type: 'string',
          description: 'Checkpoint id returned from checkpoint_save.',
        },
        targetSlug: {
          type: 'string',
          description:
            'Slug under which the restored canvas will be saved in the current workspace (e.g. "design-v2").',
        },
        overwrite: {
          type: 'boolean',
          description:
            'When true, replaces an existing canvas with the same targetSlug. Default false — an existing canvas causes an error.',
        },
      },
      required: ['checkpointId', 'targetSlug'],
    },
    execute: async (
      args: { checkpointId: string; targetSlug: string; overwrite?: boolean },
      workspaceId: string,
      client: DaemonClient,
    ): Promise<{ canvasId: string; url: string; elementCount: number }> => {
      validateCheckpointId(args.checkpointId)
      const res = await client.request(`/api/workspaces/${workspaceId}/checkpoints/${args.checkpointId}/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetSlug: args.targetSlug,
          overwrite: args.overwrite ?? false,
        }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null
        throw new Error(body?.message ?? `Checkpoint restore failed: ${res.status}`)
      }
      const body = (await res.json()) as { canvasId: string; elementCount: number }
      const url = daemonUrl(client, `/canvas/${workspaceId}/${args.targetSlug}`)
      return {
        canvasId: body.canvasId,
        url,
        elementCount: body.elementCount,
      }
    },
  }
}
