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
  // Number of live raw Excalidraw nodes (isDeleted !== true). Note: composite
  // annotations like box_with_label decompose into multiple nodes (rect + text),
  // so this count is higher than the number of logical annotate() calls. Use it
  // for scope estimation, not for counting annotation operations.
  elementCount: z.number(),
  // Elements in LoroList insertion order, including tombstones for history context.
  elements: z.array(elementSummarySchema),
})

export type ElementSummary = z.infer<typeof elementSummarySchema>
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
  return { elementCount, elements }
}
