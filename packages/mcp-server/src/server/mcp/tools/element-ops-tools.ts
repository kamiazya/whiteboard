import { z } from 'zod'
import type { DaemonClient } from '../daemon-client.js'
import { apiGetSnapshot, apiPostLoroUpdate } from './annotate.js'
import { parseCanvasId } from './canvas-id.js'
import {
  applyAlign,
  applyAssignToGroup,
  applyClear,
  applyDelete,
  applyDeleteGroup,
  applyDeleteMany,
  applyDistribute,
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

export const alignInputSchema = z.object({
  canvasId: z.string().describe('Canvas ID in "{workspaceId}/{slug}" form.'),
  elementIds: z
    .array(z.string())
    .min(2)
    .describe('Element ids to align. Needs at least 2; the orthogonal axis is left untouched.'),
  alignment: z
    .enum(['left', 'center', 'right', 'top', 'middle', 'bottom'])
    .describe("Target axis. 'left'/'right'/'center' move x; 'top'/'bottom'/'middle' move y."),
})

export const alignOutputSchema = z.object({
  elementIds: z.array(z.string()),
  alignment: z.enum(['left', 'center', 'right', 'top', 'middle', 'bottom']),
})

export const distributeInputSchema = z.object({
  canvasId: z.string().describe('Canvas ID in "{workspaceId}/{slug}" form.'),
  elementIds: z
    .array(z.string())
    .min(3)
    .describe(
      'Element ids to distribute. Needs at least 3; first and last (along the chosen axis) stay fixed.',
    ),
  direction: z
    .enum(['horizontal', 'vertical'])
    .describe('"horizontal" distributes along x; "vertical" distributes along y.'),
})

export const distributeOutputSchema = z.object({
  elementIds: z.array(z.string()),
  direction: z.enum(['horizontal', 'vertical']),
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

export const updateElementInputShape = {
  canvasId: z.string().describe('Canvas ID in "{workspaceId}/{slug}" form.'),
  elementId: z
    .string()
    .describe('Target element id (from canvas_inspect or annotate result). Throws if not found.'),
  patch: z
    .record(z.string(), z.unknown())
    .describe(
      'Partial element fields to merge (e.g. { strokeColor: "#1971c2", x: 100, width: 200 }). Only valid Excalidraw element fields are applied; unknown keys are ignored. For text/box_with_label elements, `text` replaces the element\'s own body text. For arrow elements, `text` is REJECTED (throws) rather than silently ignored: an arrow\'s label is a separate bound text element, not a `text` field on the arrow — use annotate (type="arrow", label=...) to add one, or target that label element\'s own id here to edit it.',
    ),
} satisfies z.ZodRawShape

// Partially update fields on an existing element. Useful for relabeling or small
// geometry/style tweaks. The caller is responsible for patch value validity.
export function updateElementTool() {
  return {
    name: 'update_element',
    description:
      'Patch fields of an existing element in-place (e.g., change text, strokeColor, x/y/width/height). Any Excalidraw element field can be set via patch, except `text` on arrow elements — arrows label via a separate bound text element (see annotate), so that combination throws instead of silently doing nothing.',
    // Derived from the Zod shape so the JSON-Schema view can never drift from
    // what registerToolWithAnnotations actually validates against.
    inputSchema: z.toJSONSchema(z.object(updateElementInputShape)) as {
      type: 'object'
      properties: Record<string, unknown>
      required?: string[]
    },
    execute: async (
      args: { canvasId: string; elementId: string; patch: Record<string, unknown> },
      client: DaemonClient,
    ): Promise<z.infer<typeof elementIdOutputSchema>> => {
      const { workspaceId, slug } = parseCanvasId(args.canvasId)
      const doc = await apiGetSnapshot(client, workspaceId, slug)
      const prevVV = doc.version()
      applyUpdate(doc, args.elementId, args.patch)
      doc.commit()
      await apiPostLoroUpdate(
        client,
        workspaceId,
        slug,
        doc.export({ mode: 'update', from: prevVV }),
      )
      return { elementId: args.elementId }
    },
  }
}

export const deleteElementInputShape = {
  canvasId: z.string().describe('Canvas ID in "{workspaceId}/{slug}" form.'),
  elementId: z
    .string()
    .describe(
      'Target element id. Soft-delete (tombstone) — element is removed from visible scene but kept in CRDT history. No-op if already deleted.',
    ),
} satisfies z.ZodRawShape

// Soft-delete an element by setting isDeleted=true so the CRDT delete still propagates.
export function deleteElementTool() {
  return {
    name: 'delete_element',
    description:
      'Soft-delete an element by setting isDeleted=true (tombstone). The element stays in the LoroList so the delete op propagates across clients; Excalidraw hides it automatically.',
    // Derived from the Zod shape so the JSON-Schema view can never drift from
    // what registerToolWithAnnotations actually validates against.
    inputSchema: z.toJSONSchema(z.object(deleteElementInputShape)) as {
      type: 'object'
      properties: Record<string, unknown>
      required?: string[]
    },
    execute: async (
      args: { canvasId: string; elementId: string },
      client: DaemonClient,
    ): Promise<z.infer<typeof elementIdOutputSchema>> => {
      const { workspaceId, slug } = parseCanvasId(args.canvasId)
      const doc = await apiGetSnapshot(client, workspaceId, slug)
      const prevVV = doc.version()
      applyDelete(doc, args.elementId)
      doc.commit()
      await apiPostLoroUpdate(
        client,
        workspaceId,
        slug,
        doc.export({ mode: 'update', from: prevVV }),
      )
      return { elementId: args.elementId }
    },
  }
}

export const deleteElementsInputShape = {
  canvasId: z.string().describe('Canvas ID in "{workspaceId}/{slug}" form.'),
  elementIds: z
    .array(z.string())
    .min(1)
    .describe(
      'Element ids to soft-delete (tombstone) in 1 snapshot/commit/broadcast. Always prefer this over multiple delete_element calls — it is faster and atomic.',
    ),
} satisfies z.ZodRawShape

// Tombstone multiple elements in one snapshot/commit/broadcast. This is cheaper
// than calling delete_element repeatedly and remains all-or-nothing.
export function deleteElementsTool() {
  return {
    name: 'delete_elements',
    description:
      'Soft-delete multiple elements in one snapshot/commit/broadcast. All-or-nothing: if any id is missing, nothing is deleted. Duplicates are deduped. Already-deleted ids are idempotent (no error). Use this instead of calling delete_element N times.',
    // Derived from the Zod shape so the JSON-Schema view can never drift from
    // what registerToolWithAnnotations actually validates against.
    inputSchema: z.toJSONSchema(z.object(deleteElementsInputShape)) as {
      type: 'object'
      properties: Record<string, unknown>
      required?: string[]
    },
    execute: async (
      args: { canvasId: string; elementIds: string[] },
      client: DaemonClient,
    ): Promise<z.infer<typeof deletedElementsOutputSchema>> => {
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

export const canvasClearInputShape = {
  canvasId: z.string().describe('Canvas ID (workspaceId/slug)'),
} satisfies z.ZodRawShape

// Tombstone every non-deleted element so the canvas can be reset efficiently in
// one snapshot/commit/update cycle.
export function canvasClearTool() {
  return {
    name: 'canvas_clear',
    description:
      'Soft-delete all non-deleted elements on the canvas in one snapshot/commit/broadcast. Tombstone semantics identical to delete_element. Returns { clearedCount }. Idempotent: a second call on an empty canvas returns 0.',
    // Derived from the Zod shape so the JSON-Schema view can never drift from
    // what registerToolWithAnnotations actually validates against.
    inputSchema: z.toJSONSchema(z.object(canvasClearInputShape)) as {
      type: 'object'
      properties: Record<string, unknown>
      required?: string[]
    },
    execute: async (
      args: { canvasId: string },
      client: DaemonClient,
    ): Promise<z.infer<typeof clearedCountOutputSchema>> => {
      const { workspaceId, slug } = parseCanvasId(args.canvasId)
      const doc = await apiGetSnapshot(client, workspaceId, slug)
      const prevVV = doc.version()
      const clearedCount = applyClear(doc)
      doc.commit()
      await apiPostLoroUpdate(
        client,
        workspaceId,
        slug,
        doc.export({ mode: 'update', from: prevVV }),
      )
      return { clearedCount }
    },
  }
}

export const moveElementsInputShape = {
  canvasId: z.string().describe('Canvas ID in "{workspaceId}/{slug}" form.'),
  elementIds: z
    .array(z.string())
    .min(1)
    .describe(
      'Element ids to move together. All ids in the same group are translated by the same (dx, dy) in one batched commit.',
    ),
  dx: z.number().describe('Horizontal translation in world coordinates (px). Negative = left.'),
  dy: z.number().describe('Vertical translation in world coordinates (px). Negative = up.'),
} satisfies z.ZodRawShape

// Move multiple elements by the same dx/dy. Missing ids abort the whole operation.
export function moveElementsTool() {
  return {
    name: 'move_elements',
    description:
      'Translate multiple elements by the same (dx, dy). All-or-nothing: if any id is missing, nothing is moved.',
    // Derived from the Zod shape so the JSON-Schema view can never drift from
    // what registerToolWithAnnotations actually validates against.
    inputSchema: z.toJSONSchema(z.object(moveElementsInputShape)) as {
      type: 'object'
      properties: Record<string, unknown>
      required?: string[]
    },
    execute: async (
      args: { canvasId: string; elementIds: string[]; dx: number; dy: number },
      client: DaemonClient,
    ): Promise<z.infer<typeof elementIdsOutputSchema>> => {
      const { workspaceId, slug } = parseCanvasId(args.canvasId)
      const doc = await apiGetSnapshot(client, workspaceId, slug)
      const prevVV = doc.version()
      applyMove(doc, args.elementIds, args.dx, args.dy)
      doc.commit()
      await apiPostLoroUpdate(
        client,
        workspaceId,
        slug,
        doc.export({ mode: 'update', from: prevVV }),
      )
      return { elementIds: args.elementIds }
    },
  }
}

// Snap multiple elements to a shared edge or centre. Bound arrows re-snap to
// the new box centres because the underlying applyMove handles binding.
export function alignElementsTool() {
  return {
    name: 'align_elements',
    description:
      'Align multiple elements to a shared edge or centre. left / right / center act on x; top / bottom / middle act on y. The orthogonal axis is left untouched so align_left + distribute_vertical can be chained. Needs ≥ 2 elements. All-or-nothing on missing ids.',
    // Single source of truth for the contract: the Zod input/output schemas.
    // execute()'s arg + return types are inferred so a future schema edit
    // can't drift from the handler signature.
    inputSchema: alignInputSchema,
    execute: async (
      args: z.infer<typeof alignInputSchema>,
      client: DaemonClient,
    ): Promise<z.infer<typeof alignOutputSchema>> => {
      const { workspaceId, slug } = parseCanvasId(args.canvasId)
      const doc = await apiGetSnapshot(client, workspaceId, slug)
      const prevVV = doc.version()
      applyAlign(doc, args.elementIds, args.alignment)
      doc.commit()
      await apiPostLoroUpdate(
        client,
        workspaceId,
        slug,
        doc.export({ mode: 'update', from: prevVV }),
      )
      return { elementIds: args.elementIds, alignment: args.alignment }
    },
  }
}

// Even-space the inner elements between the two outer ones along the chosen
// axis, keeping the leading and trailing element fixed in place.
export function distributeElementsTool() {
  return {
    name: 'distribute_elements',
    description:
      'Distribute multiple elements with even spacing along an axis. Sorts by the chosen axis, keeps the leading and trailing element fixed, and shifts everything in between so the gap between adjacent elements is constant. Needs ≥ 3 elements. All-or-nothing on missing ids.',
    inputSchema: distributeInputSchema,
    execute: async (
      args: z.infer<typeof distributeInputSchema>,
      client: DaemonClient,
    ): Promise<z.infer<typeof distributeOutputSchema>> => {
      const { workspaceId, slug } = parseCanvasId(args.canvasId)
      const doc = await apiGetSnapshot(client, workspaceId, slug)
      const prevVV = doc.version()
      applyDistribute(doc, args.elementIds, args.direction)
      doc.commit()
      await apiPostLoroUpdate(
        client,
        workspaceId,
        slug,
        doc.export({ mode: 'update', from: prevVV }),
      )
      return { elementIds: args.elementIds, direction: args.direction }
    },
  }
}

export const assignToGroupInputShape = {
  canvasId: z.string().describe('Canvas ID (workspaceId/slug)'),
  groupId: z
    .string()
    .describe(
      'Free-form group identifier. Pick a readable string (kebab-case recommended). Can be reused to grow an existing group.',
    ),
  elementIds: z.array(z.string()).min(1).describe('Excalidraw element ids to add to the group.'),
} satisfies z.ZodRawShape

// Tool for adding members to a logical group via Excalidraw's native groupIds.
// Pick a readable free-form groupId so the set can be found and deleted later.
export function assignToGroupTool() {
  return {
    name: 'assign_to_group',
    description:
      "Add elements to a logical group by appending a groupId to their `groupIds: string[]`. Use a meaningful user-chosen groupId (e.g. 'section-11-before') so delete_group / list_groups can target the set later. Idempotent: already-assigned members are skipped. All-or-nothing on missing ids.",
    // Derived from the Zod shape so the JSON-Schema view can never drift from
    // what registerToolWithAnnotations actually validates against.
    inputSchema: z.toJSONSchema(z.object(assignToGroupInputShape)) as {
      type: 'object'
      properties: Record<string, unknown>
      required?: string[]
    },
    execute: async (
      args: { canvasId: string; groupId: string; elementIds: string[] },
      client: DaemonClient,
    ): Promise<z.infer<typeof assignGroupOutputSchema>> => {
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

export const deleteGroupInputShape = {
  canvasId: z.string().describe('Canvas ID (workspaceId/slug)'),
  groupId: z.string().describe('Group identifier assigned via assign_to_group.'),
} satisfies z.ZodRawShape

// Tombstone every element in the given groupId in one shot.
export function deleteGroupTool() {
  return {
    name: 'delete_group',
    description:
      'Soft-delete all non-deleted elements belonging to a groupId in one snapshot/commit/broadcast. Returns { deletedElementIds }. Returns empty array if the group has no live members.',
    // Derived from the Zod shape so the JSON-Schema view can never drift from
    // what registerToolWithAnnotations actually validates against.
    inputSchema: z.toJSONSchema(z.object(deleteGroupInputShape)) as {
      type: 'object'
      properties: Record<string, unknown>
      required?: string[]
    },
    execute: async (
      args: { canvasId: string; groupId: string },
      client: DaemonClient,
    ): Promise<z.infer<typeof deletedElementsOutputSchema>> => {
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

export const listGroupsInputShape = {
  canvasId: z.string().describe('Canvas ID (workspaceId/slug)'),
} satisfies z.ZodRawShape

// List every group on the canvas. memberIds include only non-deleted elements. Read-only.
export function listGroupsTool() {
  return {
    name: 'list_groups',
    description:
      'List all logical groups on the canvas and their member element ids (tombstoned members excluded). Read-only.',
    // Derived from the Zod shape so the JSON-Schema view can never drift from
    // what registerToolWithAnnotations actually validates against.
    inputSchema: z.toJSONSchema(z.object(listGroupsInputShape)) as {
      type: 'object'
      properties: Record<string, unknown>
      required?: string[]
    },
    execute: async (
      args: { canvasId: string },
      client: DaemonClient,
    ): Promise<z.infer<typeof listGroupsOutputSchema>> => {
      const { workspaceId, slug } = parseCanvasId(args.canvasId)
      const doc = await apiGetSnapshot(client, workspaceId, slug)
      return { groups: listGroups(doc) }
    },
  }
}

export const reorderElementsInputShape = {
  canvasId: z.string().describe('Canvas ID (workspaceId/slug)'),
  elementIds: z.array(z.string()).min(1).describe('Element ids to reorder together.'),
  action: z
    .enum(['front', 'back'])
    .describe(
      '"front" = to top of stacking order (rendered above others); "back" = to bottom (rendered behind others).',
    ),
} satisfies z.ZodRawShape

// Change z-order by moving the selected elementIds together to the list front or
// back. Excalidraw draws later elements in front, and native Loro moves avoid tombstones.
export function reorderElementsTool() {
  return {
    name: 'reorder_elements',
    description:
      'Change z-order (layer) of elements. "front" brings elements to the top (rendered above others); "back" sends them to the bottom. Relative order among the selected ids is preserved. All-or-nothing: if any id is missing, nothing changes.',
    // Derived from the Zod shape so the JSON-Schema view can never drift from
    // what registerToolWithAnnotations actually validates against.
    inputSchema: z.toJSONSchema(z.object(reorderElementsInputShape)) as {
      type: 'object'
      properties: Record<string, unknown>
      required?: string[]
    },
    execute: async (
      args: { canvasId: string; elementIds: string[]; action: 'front' | 'back' },
      client: DaemonClient,
    ): Promise<z.infer<typeof reorderOutputSchema>> => {
      const { workspaceId, slug } = parseCanvasId(args.canvasId)
      const doc = await apiGetSnapshot(client, workspaceId, slug)
      const prevVV = doc.version()
      applyReorder(doc, args.elementIds, args.action)
      doc.commit()
      await apiPostLoroUpdate(
        client,
        workspaceId,
        slug,
        doc.export({ mode: 'update', from: prevVV }),
      )
      return { elementIds: args.elementIds, action: args.action }
    },
  }
}
