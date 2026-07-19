import type { LoroDoc } from 'loro-crdt'
import { z } from 'zod'

// Single source of truth for the canvas_inspect contract. The registered MCP
// outputSchema, the summarizeCanvas return type, and the tool execute return type
// all derive from this one Zod schema via z.infer, so a one-sided change fails to
// compile instead of shipping schema-vs-runtime drift (the create_frame bug class).
//
// The schema also drives which fields summarizeCanvas copies: returning every
// canvas field wastes tokens and includes noisy data like image dataURLs, so the
// summary keeps only this minimal identification and geometry set.
const elementSummarySchema = z.object({
  id: z.string().describe('Element id.'),
  type: z.string().describe('Excalidraw element type (e.g. rectangle, text, frame, image).'),
  x: z.number().optional().describe('Left position.'),
  y: z.number().optional().describe('Top position.'),
  width: z.number().optional().describe('Element width.'),
  height: z.number().optional().describe('Element height.'),
  angle: z.number().optional().describe('Rotation angle in radians.'),
  fileId: z.string().optional().describe('Referenced binary file id, for image elements.'),
  text: z
    .string()
    .optional()
    .describe(
      'Text preview (collapsed to one line, truncated to 80 characters), for text elements.',
    ),
  strokeColor: z.string().optional().describe('Stroke/border color.'),
  backgroundColor: z.string().optional().describe('Fill color.'),
  isDeleted: z
    .boolean()
    .optional()
    .describe('True when this slot is a tombstone from a deleted element.'),
  name: z
    .string()
    .optional()
    .describe(
      'Frame name as set via create_frame, present only for frame elements. Lets a caller identify a frame without re-deriving it from geometry.',
    ),
})

export const canvasInspectOutputSchema = z.object({
  // Total slots in the LoroList, including deleted tombstones. Useful for
  // understanding the full history footprint of the canvas.
  nodeCount: z
    .number()
    .describe('Total slots in the underlying element list, including deleted tombstones.'),
  // Number of live raw Excalidraw nodes (isDeleted !== true). Composite
  // annotations like box_with_label expand into multiple nodes (e.g. rect + text),
  // so this count is higher than the number of logical annotate() calls when
  // composites are used. Equals logicalCount only when no composites are present.
  elementCount: z
    .number()
    .describe(
      'Number of live (non-deleted) raw Excalidraw nodes. Composite annotations like box_with_label expand into multiple nodes, so this exceeds the number of annotate() calls when composites are used.',
    ),
  // Stable alias for elementCount. Use this field when sanity-checking how many
  // visible elements the canvas holds; the name makes the intent explicit.
  // Note: composite annotations (box_with_label) still expand to multiple raw nodes
  // each, so this will exceed the number of annotate() calls when composites are used.
  logicalCount: z
    .number()
    .describe('Stable alias for elementCount, provided so callers can be explicit about intent.'),
  // Elements in LoroList insertion order, including tombstones for history context.
  elements: z
    .array(elementSummarySchema)
    .describe('Per-element summaries in insertion order, including tombstones.'),
})

type ElementSummary = z.infer<typeof elementSummarySchema>
export type CanvasSummary = z.infer<typeof canvasInspectOutputSchema>

// Field allowlist derived from the schema so it can never drift from the contract.
const SUMMARY_KEYS = Object.keys(elementSummarySchema.shape) as (keyof ElementSummary)[]

// Character limit for text previews. Long box_with_label bodies can otherwise
// bloat the MCP response, so previews are truncated to 80 characters plus an ellipsis.
const TEXT_PREVIEW_LIMIT = 80

// Collapse newlines to spaces before measuring length so previews stay one line.
function previewText(s: string): string {
  const collapsed = s.replace(/\r?\n/g, ' ')
  if (collapsed.length <= TEXT_PREVIEW_LIMIT) return collapsed
  return `${collapsed.slice(0, TEXT_PREVIEW_LIMIT)}…`
}

export function summarizeCanvas(doc: LoroDoc): CanvasSummary {
  const raw = doc.getMovableList('elements').toJSON() as Record<string, unknown>[]
  const nodeCount = raw.length
  const elements: ElementSummary[] = raw.map((el) => {
    const summary: Record<string, unknown> = {}
    for (const key of SUMMARY_KEYS) {
      const value = el[key]
      if (value === undefined) continue
      summary[key] = key === 'text' && typeof value === 'string' ? previewText(value) : value
    }
    return summary as ElementSummary
  })
  const elementCount = elements.filter((e) => !e.isDeleted).length
  // logicalCount equals elementCount. Composite annotations like box_with_label
  // expand into multiple raw nodes, so both counts exceed the number of annotate()
  // calls when composites are used. The separate field exists so callers can be
  // explicit about which count they are reading.
  const logicalCount = elementCount
  return { nodeCount, elementCount, logicalCount, elements }
}
