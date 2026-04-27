import { z } from 'zod'
import type { DaemonClient } from '../daemon-client.js'
import { apiGetSnapshot, apiPostLoroUpdate } from './annotate.js'
import { parseCanvasId } from './canvas-id.js'
import {
  applyAssignToGroup,
  applyClear,
  applyDelete,
  applyDeleteGroup,
  applyDeleteMany,
  applyMove,
  applyReorder,
  applyUpdate,
  listGroups,
} from './element-ops.js'

export const elementIdOutputSchema = z.object({ elementId: z.string() })

export const elementIdsOutputSchema = z.object({ elementIds: z.array(z.string()) })

export const deletedElementsOutputSchema = z.object({
  deletedElementIds: z.array(z.string()),
  deletedCount: z.number(),
})

export const clearedCountOutputSchema = z.object({ clearedCount: z.number() })

export const assignGroupOutputSchema = z.object({
  groupId: z.string(),
  elementIds: z.array(z.string()),
})

export const reorderOutputSchema = z.object({
  elementIds: z.array(z.string()),
  action: z.string(),
})

export const listGroupsOutputSchema = z.object({
  groups: z.array(
    z.object({
      groupId: z.string(),
      memberIds: z.array(z.string()),
    }),
  ),
})

// Partially update fields on an existing element. Useful for relabeling or small
// geometry/style tweaks. The caller is responsible for patch value validity.
export function updateElementTool() {
  return {
    name: 'update_element',
    description:
      'Patch fields of an existing element in-place (e.g., change text, strokeColor, x/y/width/height). Any Excalidraw element field can be set via patch.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        canvasId: { type: 'string', description: 'Canvas ID (workspaceId/slug)' },
        elementId: { type: 'string', description: 'Excalidraw element id returned from annotate/load_image.' },
        patch: {
          type: 'object',
          description: 'Field → value map. Values are applied verbatim with LoroMap.set.',
          additionalProperties: true,
        },
      },
      required: ['canvasId', 'elementId', 'patch'],
    },
    execute: async (
      args: { canvasId: string; elementId: string; patch: Record<string, unknown> },
      client: DaemonClient,
    ) => {
      const { workspaceId, slug } = parseCanvasId(args.canvasId)
      const doc = await apiGetSnapshot(client, workspaceId, slug)
      const prevVV = doc.version()
      applyUpdate(doc, args.elementId, args.patch)
      doc.commit()
      await apiPostLoroUpdate(client, workspaceId, slug, doc.export({ mode: 'update', from: prevVV }))
      return { elementId: args.elementId }
    },
  }
}

// Soft-delete an element by setting isDeleted=true so the CRDT delete still propagates.
export function deleteElementTool() {
  return {
    name: 'delete_element',
    description:
      'Soft-delete an element by setting isDeleted=true (tombstone). The element stays in the LoroList so the delete op propagates across clients; Excalidraw hides it automatically.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        canvasId: { type: 'string', description: 'Canvas ID (workspaceId/slug)' },
        elementId: { type: 'string' },
      },
      required: ['canvasId', 'elementId'],
    },
    execute: async (args: { canvasId: string; elementId: string }, client: DaemonClient) => {
      const { workspaceId, slug } = parseCanvasId(args.canvasId)
      const doc = await apiGetSnapshot(client, workspaceId, slug)
      const prevVV = doc.version()
      applyDelete(doc, args.elementId)
      doc.commit()
      await apiPostLoroUpdate(client, workspaceId, slug, doc.export({ mode: 'update', from: prevVV }))
      return { elementId: args.elementId }
    },
  }
}

// Tombstone multiple elements in one snapshot/commit/broadcast. This is cheaper
// than calling delete_element repeatedly and remains all-or-nothing.
export function deleteElementsTool() {
  return {
    name: 'delete_elements',
    description:
      'Soft-delete multiple elements in one snapshot/commit/broadcast. All-or-nothing: if any id is missing, nothing is deleted. Duplicates are deduped. Already-deleted ids are idempotent (no error). Use this instead of calling delete_element N times.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        canvasId: { type: 'string', description: 'Canvas ID (workspaceId/slug)' },
        elementIds: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: 'Excalidraw element ids to tombstone.',
        },
      },
      required: ['canvasId', 'elementIds'],
    },
    execute: async (
      args: { canvasId: string; elementIds: string[] },
      client: DaemonClient,
    ) => {
      const { workspaceId, slug } = parseCanvasId(args.canvasId)
      const doc = await apiGetSnapshot(client, workspaceId, slug)
      const prevVV = doc.version()
      const deleted = applyDeleteMany(doc, args.elementIds)
      doc.commit()
      await apiPostLoroUpdate(
        client,
        workspaceId,
        slug,
        doc.export({ mode: 'update', from: prevVV }),
      )
      return { deletedElementIds: deleted, deletedCount: deleted.length }
    },
  }
}

// Tombstone every non-deleted element so the canvas can be reset efficiently in
// one snapshot/commit/update cycle.
export function canvasClearTool() {
  return {
    name: 'canvas_clear',
    description:
      'Soft-delete all non-deleted elements on the canvas in one snapshot/commit/broadcast. Tombstone semantics identical to delete_element. Returns { clearedCount }. Idempotent: a second call on an empty canvas returns 0.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        canvasId: { type: 'string', description: 'Canvas ID (workspaceId/slug)' },
      },
      required: ['canvasId'],
    },
    execute: async (args: { canvasId: string }, client: DaemonClient) => {
      const { workspaceId, slug } = parseCanvasId(args.canvasId)
      const doc = await apiGetSnapshot(client, workspaceId, slug)
      const prevVV = doc.version()
      const clearedCount = applyClear(doc)
      doc.commit()
      await apiPostLoroUpdate(client, workspaceId, slug, doc.export({ mode: 'update', from: prevVV }))
      return { clearedCount }
    },
  }
}

// Move multiple elements by the same dx/dy. Missing ids abort the whole operation.
export function moveElementsTool() {
  return {
    name: 'move_elements',
    description:
      'Translate multiple elements by the same (dx, dy). All-or-nothing: if any id is missing, nothing is moved.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        canvasId: { type: 'string', description: 'Canvas ID (workspaceId/slug)' },
        elementIds: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
        },
        dx: { type: 'number' },
        dy: { type: 'number' },
      },
      required: ['canvasId', 'elementIds', 'dx', 'dy'],
    },
    execute: async (
      args: { canvasId: string; elementIds: string[]; dx: number; dy: number },
      client: DaemonClient,
    ) => {
      const { workspaceId, slug } = parseCanvasId(args.canvasId)
      const doc = await apiGetSnapshot(client, workspaceId, slug)
      const prevVV = doc.version()
      applyMove(doc, args.elementIds, args.dx, args.dy)
      doc.commit()
      await apiPostLoroUpdate(client, workspaceId, slug, doc.export({ mode: 'update', from: prevVV }))
      return { elementIds: args.elementIds }
    },
  }
}

// Tool for adding members to a logical group via Excalidraw's native groupIds.
// Pick a readable free-form groupId so the set can be found and deleted later.
export function assignToGroupTool() {
  return {
    name: 'assign_to_group',
    description:
      "Add elements to a logical group by appending a groupId to their `groupIds: string[]`. Use a meaningful user-chosen groupId (e.g. 'section-11-before') so delete_group / list_groups can target the set later. Idempotent: already-assigned members are skipped. All-or-nothing on missing ids.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        canvasId: { type: 'string', description: 'Canvas ID (workspaceId/slug)' },
        groupId: {
          type: 'string',
          description:
            'Free-form group identifier. Pick a readable string (kebab-case recommended). Can be reused to grow an existing group.',
        },
        elementIds: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
        },
      },
      required: ['canvasId', 'groupId', 'elementIds'],
    },
    execute: async (
      args: { canvasId: string; groupId: string; elementIds: string[] },
      client: DaemonClient,
    ) => {
      const { workspaceId, slug } = parseCanvasId(args.canvasId)
      const doc = await apiGetSnapshot(client, workspaceId, slug)
      const prevVV = doc.version()
      applyAssignToGroup(doc, args.groupId, args.elementIds)
      doc.commit()
      await apiPostLoroUpdate(
        client,
        workspaceId,
        slug,
        doc.export({ mode: 'update', from: prevVV }),
      )
      return { groupId: args.groupId, elementIds: args.elementIds }
    },
  }
}

// Tombstone every element in the given groupId in one shot.
export function deleteGroupTool() {
  return {
    name: 'delete_group',
    description:
      'Soft-delete all non-deleted elements belonging to a groupId in one snapshot/commit/broadcast. Returns { deletedElementIds }. Returns empty array if the group has no live members.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        canvasId: { type: 'string', description: 'Canvas ID (workspaceId/slug)' },
        groupId: { type: 'string' },
      },
      required: ['canvasId', 'groupId'],
    },
    execute: async (
      args: { canvasId: string; groupId: string },
      client: DaemonClient,
    ) => {
      const { workspaceId, slug } = parseCanvasId(args.canvasId)
      const doc = await apiGetSnapshot(client, workspaceId, slug)
      const prevVV = doc.version()
      const deleted = applyDeleteGroup(doc, args.groupId)
      doc.commit()
      await apiPostLoroUpdate(
        client,
        workspaceId,
        slug,
        doc.export({ mode: 'update', from: prevVV }),
      )
      return { deletedElementIds: deleted, deletedCount: deleted.length }
    },
  }
}

// List every group on the canvas. memberIds include only non-deleted elements. Read-only.
export function listGroupsTool() {
  return {
    name: 'list_groups',
    description:
      'List all logical groups on the canvas and their member element ids (tombstoned members excluded). Read-only.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        canvasId: { type: 'string', description: 'Canvas ID (workspaceId/slug)' },
      },
      required: ['canvasId'],
    },
    execute: async (args: { canvasId: string }, client: DaemonClient) => {
      const { workspaceId, slug } = parseCanvasId(args.canvasId)
      const doc = await apiGetSnapshot(client, workspaceId, slug)
      return { groups: listGroups(doc) }
    },
  }
}

// Change z-order by moving the selected elementIds together to the list front or
// back. Excalidraw draws later elements in front, and native Loro moves avoid tombstones.
export function reorderElementsTool() {
  return {
    name: 'reorder_elements',
    description:
      'Change z-order (layer) of elements. "front" brings elements to the top (rendered above others); "back" sends them to the bottom. Relative order among the selected ids is preserved. All-or-nothing: if any id is missing, nothing changes.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        canvasId: { type: 'string', description: 'Canvas ID (workspaceId/slug)' },
        elementIds: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
        },
        action: {
          type: 'string',
          enum: ['front', 'back'],
          description:
            '"front" = to top of stacking order (rendered above others); "back" = to bottom (rendered behind others).',
        },
      },
      required: ['canvasId', 'elementIds', 'action'],
    },
    execute: async (
      args: { canvasId: string; elementIds: string[]; action: 'front' | 'back' },
      client: DaemonClient,
    ) => {
      const { workspaceId, slug } = parseCanvasId(args.canvasId)
      const doc = await apiGetSnapshot(client, workspaceId, slug)
      const prevVV = doc.version()
      applyReorder(doc, args.elementIds, args.action)
      doc.commit()
      await apiPostLoroUpdate(client, workspaceId, slug, doc.export({ mode: 'update', from: prevVV }))
      return { elementIds: args.elementIds, action: args.action }
    },
  }
}
