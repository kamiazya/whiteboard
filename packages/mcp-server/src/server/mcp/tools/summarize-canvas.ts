import type { LoroDoc } from 'loro-crdt'

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

export interface ElementSummary {
  id: string
  type: string
  x?: number
  y?: number
  width?: number
  height?: number
  angle?: number
  fileId?: string
  text?: string
  strokeColor?: string
  backgroundColor?: string
  isDeleted?: boolean
}

export interface CanvasSummary {
  // Number of live elements (isDeleted !== true). Useful for estimating scope.
  elementCount: number
  // Elements in LoroList insertion order, including tombstones for history context.
  elements: ElementSummary[]
}

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
        summary[key] = key === 'text' && typeof el[key] === 'string' ? previewText(el[key] as string) : el[key]
      }
    }
    return summary as unknown as ElementSummary
  })
  const elementCount = elements.filter((e) => !e.isDeleted).length
  return { elementCount, elements }
}
