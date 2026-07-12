// MCP wrappers around the canvas-version routes.
//
// These replace the deleted `checkpoint_save` / `checkpoint_restore` tools.
// Versions live next to their canvas (slug-scoped) and benefit from the
// existing per-canvas LRU + branch awareness, where checkpoints stored a
// global standalone snapshot. The version_restore tool's `targetSlug`
// option preserves the "fork into a separate canvas" use case checkpoints
// previously covered.

import { z } from 'zod'
import {
  type ListVersionsResponse,
  type RestoreVersionRequest,
  type SaveVersionResponse,
  listVersionsResponseSchema,
  saveVersionResponseSchema,
} from '../../../shared/api-contracts/canvas.js'
import type { DaemonClient } from '../daemon-client.js'
import { parseCanvasId } from './canvas-id.js'

export const versionSaveOutputSchema = z.object({
  versionId: z.string(),
  elementCount: z.number(),
  label: z.string().optional(),
})

export const versionRestoreOutputSchema = z.object({
  canvasId: z.string(),
  restoredAs: z.enum(['in-place', 'new-canvas']),
  elementCount: z.number().optional(),
})

export const versionListOutputSchema = z.object({
  versions: listVersionsResponseSchema.shape.versions,
})

interface VersionSaveArgs {
  canvasId: string
  label?: string
}

interface VersionRestoreArgs {
  canvasId: string
  versionId: string
  targetSlug?: string
  overwrite?: boolean
}

interface VersionListArgs {
  canvasId: string
}

export const versionSaveInputShape = {
  canvasId: z.string().describe('Canvas ID in "{workspaceId}/{slug}" form.'),
  label: z
    .string()
    .optional()
    .describe('Optional human-readable label shown in the History panel.'),
} satisfies z.ZodRawShape

export function versionSaveTool() {
  return {
    name: 'version_save',
    description:
      'Save a labeled version of the canvas state. Returns versionId for later restore. Versions are slug-scoped (canvas-local) and auto-pruned per-canvas, replacing the prior checkpoint flow.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        canvasId: { type: 'string', description: 'Canvas ID in "{workspaceId}/{slug}" form.' },
        label: {
          type: 'string',
          description:
            'Optional human-readable label (shown in the History panel). When omitted, the version is saved without a label and counts toward the auto-version pool.',
        },
      },
      required: ['canvasId'],
    },
    execute: async (
      args: VersionSaveArgs,
      client: DaemonClient,
    ): Promise<z.infer<typeof versionSaveOutputSchema>> => {
      const { workspaceId, slug } = parseCanvasId(args.canvasId)
      const body: Record<string, unknown> = {}
      if (args.label !== undefined) body.label = args.label
      const res = await client.request(
        `/api/workspaces/${workspaceId}/canvases/${encodeURIComponent(slug)}/versions`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      )
      if (!res.ok) {
        const errBody = (await res.json().catch(() => null)) as { message?: string } | null
        throw new Error(errBody?.message ?? `version_save failed: ${res.status}`)
      }
      const parsed = saveVersionResponseSchema.parse(await res.json())
      return {
        versionId: parsed.version.id,
        elementCount: parsed.version.elementCount,
        ...(parsed.version.label !== undefined ? { label: parsed.version.label } : {}),
      }
    },
  }
}

export const versionRestoreInputShape = {
  canvasId: z.string().describe('Source canvas ID in "{workspaceId}/{slug}" form.'),
  versionId: z.string().describe('Version id returned from version_save or version_list.'),
  targetSlug: z
    .string()
    .optional()
    .describe(
      'When set, restore as a new canvas under this slug in the same workspace. Original canvas is left untouched.',
    ),
  overwrite: z
    .boolean()
    .optional()
    .describe(
      'Only used with targetSlug. When true, replace an existing canvas at targetSlug. Default false.',
    ),
} satisfies z.ZodRawShape

export function versionRestoreTool() {
  return {
    name: 'version_restore',
    description:
      'Restore a saved version. Default = in-place reconcile against the source canvas. Pass targetSlug to instead write the past doc as a brand-new canvas in the same workspace (replaces the deleted checkpoint_restore flow).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        canvasId: {
          type: 'string',
          description: 'Source canvas ID in "{workspaceId}/{slug}" form.',
        },
        versionId: {
          type: 'string',
          description: 'Version id returned from version_save or listed via the History panel.',
        },
        targetSlug: {
          type: 'string',
          description:
            'When set, restore as a new canvas under this slug in the same workspace instead of reconciling in place. The original canvas is left untouched.',
        },
        overwrite: {
          type: 'boolean',
          description:
            'Only used with targetSlug. When true, replace an existing canvas at targetSlug. Default false — an existing target slug fails with output_exists.',
        },
      },
      required: ['canvasId', 'versionId'],
    },
    execute: async (
      args: VersionRestoreArgs,
      client: DaemonClient,
    ): Promise<z.infer<typeof versionRestoreOutputSchema>> => {
      const { workspaceId, slug } = parseCanvasId(args.canvasId)
      const body: RestoreVersionRequest = {}
      if (args.targetSlug !== undefined) body.targetSlug = args.targetSlug
      if (args.overwrite !== undefined) body.overwrite = args.overwrite
      const res = await client.request(
        `/api/workspaces/${workspaceId}/canvases/${encodeURIComponent(slug)}/versions/${args.versionId}/restore`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      )
      if (!res.ok) {
        const errBody = (await res.json().catch(() => null)) as { message?: string } | null
        throw new Error(errBody?.message ?? `version_restore failed: ${res.status}`)
      }
      const json = (await res.json()) as Record<string, unknown>
      // restore-as-new-canvas: { canvasId, elementCount }
      // in-place reconcile: { ok: true } — derive canvasId from input.
      if (typeof json.canvasId === 'string') {
        return {
          canvasId: json.canvasId,
          restoredAs: 'new-canvas',
          ...(typeof json.elementCount === 'number' ? { elementCount: json.elementCount } : {}),
        }
      }
      return { canvasId: args.canvasId, restoredAs: 'in-place' }
    },
  }
}

export const versionListInputShape = {
  canvasId: z.string().describe('Canvas ID in "{workspaceId}/{slug}" form.'),
} satisfies z.ZodRawShape

export function versionListTool() {
  return {
    name: 'version_list',
    description:
      'List saved versions for a canvas (most recent first). Combine with version_restore to replay a specific labeled snapshot.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        canvasId: { type: 'string', description: 'Canvas ID in "{workspaceId}/{slug}" form.' },
      },
      required: ['canvasId'],
    },
    execute: async (
      args: VersionListArgs,
      client: DaemonClient,
    ): Promise<z.infer<typeof versionListOutputSchema>> => {
      const { workspaceId, slug } = parseCanvasId(args.canvasId)
      const res = await client.request(
        `/api/workspaces/${workspaceId}/canvases/${encodeURIComponent(slug)}/versions`,
      )
      if (!res.ok) {
        throw new Error(`version_list failed: ${res.status}`)
      }
      const parsed: ListVersionsResponse = listVersionsResponseSchema.parse(await res.json())
      return { versions: parsed.versions }
    },
  }
}
