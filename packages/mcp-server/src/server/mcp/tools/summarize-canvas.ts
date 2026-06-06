import type { LoroDoc } from 'loro-crdt'
import { z } from 'zod'

// Extract the key canvas fields Claude (via MCP) needs to reason about state.
// Returning every field wastes tokens and includes noisy data like image dataURLs,
// so this keeps only a minimal identification and geometry set.
const SUMMARY_KEYS = [
  'id',
  'type',
  'x',
  'y',
  'width',
  'height',
  'angle',
  'fileId',
  'text',
  'strokeColor',
  'backgroundColor',
  'isDeleted',
] as const

// Single source of truth for the canvas_inspect contract. The registered MCP
// outputSchema, the summarizeCanvas return type, and the tool execute return type
// all derive from this one Zod schema via z.infer, so a one-sided change fails to
// compile instead of shipping schema-vs-runtime drift (the create_frame bug class).
const elementSummarySchema = z.object({
  id: z.string(),
  type: z.string(),
  x: z.number().optional(),
  y: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  angle: z.number().optional(),
  fileId: z.string().optional(),
  text: z.string().optional(),
  strokeColor: z.string().optional(),
  backgroundColor: z.string().optional(),
  isDeleted: z.boolean().optional(),
})

export const canvasInspectOutputSchema = z.object({
  // Number of live elements (isDeleted !== true). Useful for estimating scope.
  elementCount: z.number(),
  // Elements in LoroList insertion order, including tombstones for history context.
  elements: z.array(elementSummarySchema),
})

export type ElementSummary = z.infer<typeof elementSummarySchema>
export type CanvasSummary = z.infer<typeof canvasInspectOutputSchema>

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
  const elements: ElementSummary[] = raw.map((el) => {
    const summary: Record<string, unknown> = {}
    for (const key of SUMMARY_KEYS) {
      if (el[key] !== undefined) {
        summary[key] =
          key === 'text' && typeof el[key] === 'string' ? previewText(el[key] as string) : el[key]
      }
    }
    return summary as unknown as ElementSummary
  })
  const elementCount = elements.filter((e) => !e.isDeleted).length
  return { elementCount, elements }
}
