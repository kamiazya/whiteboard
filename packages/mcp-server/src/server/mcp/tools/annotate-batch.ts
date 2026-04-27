import { LoroDoc } from 'loro-crdt'
import { z } from 'zod'
import type { DaemonClient } from '../daemon-client.js'
import {
  annotationResultSchema,
  type AnnotationResult,
  type AnnotationSpec,
  apiGetSnapshot,
  apiPostLoroUpdate,
  appendAnnotationToDoc,
  flattenAnnotationResult,
} from './annotate.js'
import { decomposeBoxWithLabel } from './box-with-label.js'
import { parseCanvasId } from './canvas-id.js'
import { applyAssignToGroup } from './element-ops.js'
import { decomposeGroup } from './group.js'
import { apiGetPalette } from './palette.js'
import { type GridLayout, resolveGridPlacement, resolveLayout } from './resolve-layout.js'
import { boundsSchema } from './shared-schemas.js'

export const annotateBatchWarningSchema = z.object({
  index: z.number(),
  overflow: z.boolean().optional(),
  requiredWidth: z.number().optional(),
  requiredHeight: z.number().optional(),
  autoExpandedBy: z.number().optional(),
  actualHeight: z.number().optional(),
  missingMemberIds: z.array(z.string()).optional(),
  unresolvedBindingName: z.array(z.string()).optional(),
  message: z.string().optional(),
})

export const annotateBatchOutputSchema = z.object({
  elementIds: z.array(z.string()),
  annotations: z.array(annotationResultSchema),
  warnings: z.array(annotateBatchWarningSchema),
  byName: z.record(z.string(), annotationResultSchema),
  placements: z.array(
    z.object({
      annotationIndex: z.number(),
      rect: boundsSchema,
      elementId: z.string().optional(),
    }),
  ),
  overlaps: z.array(
    z.object({
      a: z.number(),
      b: z.number(),
      iou: z.number(),
    }),
  ),
})

// box_with_label does not auto-wrap, so insufficient width/height can cause
// visible overflow. annotate_batch returns these diagnostics as warnings so the
// caller can correct them up front.
export interface AnnotationWarning {
  index: number
  overflow?: boolean
  requiredWidth?: number
  requiredHeight?: number
  // Extra height added when autoFit=true expands the box beyond input.height.
  // autoExpandedBy > 0 signals overlap risk even when overflow stays false.
  // Callers should widen the gap or lower the next block's y position.
  autoExpandedBy?: number
  actualHeight?: number
  // group only: memberIds that did not contribute to the bbox because they were missing or deleted.
  missingMemberIds?: string[]
  // binding-name DSL only: set when a name referenced by startBoxName/endBoxName
  // was not defined earlier in the batch. The arrow still executes without snapping.
  unresolvedBindingName?: string[]
  message?: string
}

interface PlacementRect {
  x: number
  y: number
  width: number
  height: number
}

function intersectionArea(a: PlacementRect, b: PlacementRect): number {
  const xOverlap = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
  const yOverlap = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
  return xOverlap * yOverlap
}

function computeIou(a: PlacementRect, b: PlacementRect): number {
  const overlap = intersectionArea(a, b)
  if (overlap === 0) return 0
  const union = a.width * a.height + b.width * b.height - overlap
  return union === 0 ? 0 : overlap / union
}

// Batch items may omit target and use row/col grid placement instead. resolveLayout
// turns that into target {x, y}. name/startBoxName/endBoxName implement the
// binding-name DSL so later arrows can reference generated ids indirectly.
export type BatchAnnotationItem = Omit<AnnotationSpec, 'target'> & {
  target?: { x: number; y: number }
  row?: number
  col?: number
  rowSpan?: number
  colSpan?: number
  name?: string
  startBoxName?: string
  endBoxName?: string
}

// Apply many annotations with one snapshot fetch, one commit, and one update POST.
// This is much cheaper than calling annotate repeatedly for diagram-heavy flows.
export function annotateBatchTool() {
  return {
    name: 'annotate_batch',
    description:
      'Add multiple annotations in one request (single snapshot fetch, single commit, single broadcast). Supports optional grid layout for matrix/comparison diagrams. IMPORTANT: box_with_label does NOT auto-wrap long text; the caller must pre-split long lines by passing text as string[] (each element = 1 line) so the label fits within width/cellW.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        canvasId: { type: 'string', description: 'Canvas ID (workspaceId/slug)' },
        dryRun: {
          type: 'boolean',
          description: 'When true, computes placements/warnings without persisting the annotations.',
        },
        overlapThreshold: {
          type: 'number',
          description: 'IoU threshold used to report overlaps in placements. Default 0.1.',
        },
        groupAs: {
          type: 'string',
          description: 'Optional logical group id assigned to all created elements in this batch.',
        },
        layout: {
          type: 'object',
          description:
            'Optional grid layout. When set, items can specify row/col (0-indexed) instead of target. Cell top-left becomes target. Use with box_with_label (width=cellW, height=cellH) or text (align=center, width=cellW).',
          properties: {
            cols: { type: 'number' },
            rows: { type: 'number' },
            cellW: { type: 'number' },
            cellH: { type: 'number' },
            colWidths: { type: 'array', items: { type: 'number' } },
            rowHeights: { type: 'array', items: { type: 'number' } },
            gap: { type: 'number' },
            origin: {
              type: 'object',
              properties: { x: { type: 'number' }, y: { type: 'number' } },
              required: ['x', 'y'],
            },
          },
          required: ['cols', 'rows', 'gap', 'origin'],
        },
        annotations: {
          type: 'array',
          minItems: 1,
          description: 'Annotation specs to add in order.',
          items: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: ['arrow', 'text', 'rectangle', 'highlight', 'box_with_label', 'group'],
              },
              imageId: { type: 'string' },
              coords: { type: 'string', enum: ['absolute', 'relative'] },
              target: {
                type: 'object',
                description: 'Explicit position. Omit when using row/col with layout.',
                properties: { x: { type: 'number' }, y: { type: 'number' } },
                required: ['x', 'y'],
              },
              row: { type: 'number', description: 'Grid row (0-indexed). Requires layout + col, mutually exclusive with target.' },
              col: { type: 'number', description: 'Grid column (0-indexed). Requires layout + row, mutually exclusive with target.' },
              rowSpan: { type: 'number', description: 'Grid row span. Default 1. When width/height are omitted, spanned track sizes are used.' },
              colSpan: { type: 'number', description: 'Grid column span. Default 1. When width/height are omitted, spanned track sizes are used.' },
              text: {
                description:
                  'Text content. string for single line, string[] for multi-line (joined with "\\n"). box_with_label centers multi-line vertically and does NOT auto-wrap — pre-split long text into string[] to fit within width/cellW.',
                oneOf: [
                  { type: 'string' },
                  { type: 'array', items: { type: 'string' } },
                ],
              },
              title: {
                description:
                  'box_with_label/group only: title text. box_with_label renders it above the body inside the box; group renders it above the bounding rect.',
                oneOf: [
                  { type: 'string' },
                  { type: 'array', items: { type: 'string' } },
                ],
              },
              subText: {
                description:
                  'box_with_label only: caption rendered as a separate 14px text element. Placement controlled by subTextPosition. string for single line, string[] for multi-line.',
                oneOf: [
                  { type: 'string' },
                  { type: 'array', items: { type: 'string' } },
                ],
              },
              subTextPosition: {
                type: 'string',
                enum: ['top', 'inside-bottom'],
                description:
                  'box_with_label only: subText placement. Default is "inside-bottom" = bottom half inside the rect (main/sub both free-floating, center-aligned). Use "top" for a caption above the rect.',
              },
              autoFit: {
                type: 'boolean',
                description:
                  'box_with_label only: auto-fit box height to text. Default true (ON). Pass false to opt out — box keeps the caller-specified height and overflow is reported as a warning.',
              },
              color: {
                type: 'string',
                description:
                  'Stroke color. Accepts hex (#rrggbb) or semantic key: primary / success / danger / warning / neutral / info (case-insensitive).',
              },
              backgroundColor: {
                type: 'string',
                description:
                  'Fill color for rectangle / box_with_label / highlight / arrow. Hex or semantic key. Default: transparent for rect/box, strokeColor for highlight. Pair with fillStyle=solid for filled box.',
              },
              fillStyle: {
                type: 'string',
                enum: ['solid', 'hachure', 'cross-hatch'],
                description:
                  'Fill pattern for rectangle / box_with_label / highlight. Default: hachure (rect/box) / solid (highlight).',
              },
              strokeWidth: {
                type: 'number',
                description:
                  'Stroke line width. Default 2. Useful on arrow to emphasize flow.',
              },
              fontFamily: {
                type: 'number',
                enum: [1, 2, 3, 5, 6, 7, 8, 9],
                description:
                  'Text font family. Current: 5 = Excalifont (hand-drawn, default), 6 = Nunito (sans), 7 = "Lilita One" (display), 8 = "Comic Shanns" (monospace, for paths / identifiers / code), 9 = "Liberation Sans". Legacy: 1 = Virgil, 2 = Helvetica, 3 = Cascadia (UI marks "old"). Use 8 for system paths and 5 for human annotations to create visual contrast.',
              },
              fontSize: {
                type: 'number',
                description: 'text only: explicit font size in px.',
              },
              width: { type: 'number' },
              height: { type: 'number' },
              align: {
                type: 'string',
                enum: ['left', 'center', 'right'],
                description:
                  'text only: horizontal alignment. With width, target becomes the anchor (center → target.x is the block center, right → target.x is the right edge).',
              },
              endTarget: {
                type: 'object',
                properties: { x: { type: 'number' }, y: { type: 'number' } },
                required: ['x', 'y'],
              },
              startBoxId: {
                type: 'string',
                description: 'arrow only: element id whose rect is used to snap the start point to its nearest edge.',
              },
              endBoxId: {
                type: 'string',
                description: 'arrow only: element id whose rect is used to snap the end point to its nearest edge.',
              },
              label: {
                type: 'string',
                description:
                  'arrow only: label text placed at the midpoint of the (snap-applied) arrow. Adds a text element above the line.',
              },
              labelOffset: {
                type: 'number',
                description: 'arrow.label only: perpendicular distance from the line to the label center (default 6).',
              },
              labelSide: {
                type: 'string',
                enum: ['auto', 'above', 'below', 'left', 'right'],
                description:
                  'arrow.label only: which side of the line to place the label. "auto" (default) = upper side. Geometrically indeterminate combinations (horizontal + left/right, vertical + above/below) fall back to auto.',
              },
              memberIds: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'group only: element ids to enclose. The bounding rect is computed from existing non-deleted members (missing/deleted ids reported in warnings).',
              },
              padding: {
                type: 'number',
                description: 'group only: padding (px) added around the bbox (default 20).',
              },
              name: {
                type: 'string',
                description:
                  'Binding name (Task #60). Label this annotation so later arrows can reference it via startBoxName/endBoxName without knowing the generated id. For box_with_label resolves to rectId; for rectangle/text/highlight resolves to elementId.',
              },
              startBoxName: {
                type: 'string',
                description:
                  'arrow only: resolve to the rectId of a preceding annotation with the matching name. Takes precedence over startBoxId. Unresolved names are reported in warnings[].unresolvedBindingName.',
              },
              endBoxName: {
                type: 'string',
                description:
                  'arrow only: resolve to the rectId of a preceding annotation with the matching name. Takes precedence over endBoxId. Unresolved names are reported in warnings[].unresolvedBindingName.',
              },
            },
            required: ['type'],
          },
        },
      },
      required: ['canvasId', 'annotations'],
    },
    execute: async (
      args: {
        canvasId: string
        annotations: BatchAnnotationItem[]
        layout?: GridLayout
        dryRun?: boolean
        overlapThreshold?: number
        groupAs?: string
      },
      client: DaemonClient,
    ) => {
      const { workspaceId, slug } = parseCanvasId(args.canvasId)
      const sessionPalette = await apiGetPalette(client, workspaceId)
      const warnings: AnnotationWarning[] = []
      // Layer 1: resolve targets for items that need layout before touching the doc.
      // Fail fast before fetching a snapshot if layout resolution fails.
      // group does not use target, so skip resolveLayout and supply a fallback.
      // Preserve name/startBoxName/endBoxName for later binding-name resolution.
      const bindings: Array<{ name?: string; startBoxName?: string; endBoxName?: string }> = []
      const occupiedCells = new Set<string>()
      const resolvedSpecs: AnnotationSpec[] = args.annotations.map((item, index) => {
        // arrow + box binding (startBoxId / endBoxId / startBoxName / endBoxName)
        // In this mode, target/row/col may be omitted. annotate.ts computes the
        // actual geometry by snapping toward the referenced box centers.
        const hasBoxBinding =
          item.type === 'arrow' &&
          (item.startBoxId !== undefined ||
            item.endBoxId !== undefined ||
            item.startBoxName !== undefined ||
            item.endBoxName !== undefined)
        let target =
          item.type === 'group' || hasBoxBinding
            ? (item.target ?? { x: 0, y: 0 })
            : resolveLayout(args.layout, {
                row: item.row,
                col: item.col,
                target: item.target,
              })
        let width = item.width
        let height = item.height
        if (
          args.layout &&
          item.target === undefined &&
          item.row !== undefined &&
          item.col !== undefined &&
          !hasBoxBinding &&
          item.type !== 'group'
        ) {
          const placement = resolveGridPlacement(args.layout, {
            row: item.row,
            col: item.col,
            rowSpan: item.rowSpan,
            colSpan: item.colSpan,
          })
          target = { x: placement.x, y: placement.y }
          if (width === undefined) width = placement.width
          if (height === undefined) height = placement.height
          for (const message of placement.warnings) {
            warnings.push({ index, message })
          }
          for (let r = placement.row; r < placement.row + placement.rowSpan; r++) {
            for (let c = placement.col; c < placement.col + placement.colSpan; c++) {
              const key = `${r}:${c}`
              if (occupiedCells.has(key)) {
                warnings.push({ index, message: 'grid span overlaps a previously occupied cell' })
                break
              }
            }
          }
          for (let r = placement.row; r < placement.row + placement.rowSpan; r++) {
            for (let c = placement.col; c < placement.col + placement.colSpan; c++) {
              occupiedCells.add(`${r}:${c}`)
            }
          }
        }
        const { row: _r, col: _c, rowSpan: _rs, colSpan: _cs, name, startBoxName, endBoxName, ...rest } = item
        bindings.push({ name, startBoxName, endBoxName })
        return { ...rest, target, width, height, sessionPalette } as AnnotationSpec
      })
      // Layer 2: collect box_with_label overflow diagnostics without touching the doc.
      // decomposeBoxWithLabel returns [rect, text, diagnostics], so only diagnostics matter here.
      // Specs missing width/height/text are rejected later by appendAnnotationToDoc, so skip them here.
      warnings.push(...resolvedSpecs.flatMap((spec, index) => {
        if (spec.type !== 'box_with_label') return []
        if (
          (spec.text === undefined && spec.title === undefined) ||
          spec.width === undefined ||
          spec.height === undefined
        ) {
          return []
        }
        const [, , diag] = decomposeBoxWithLabel({
          target: spec.target,
          width: spec.width,
          height: spec.height,
          title: spec.title,
          text: spec.text,
          subText: spec.subText,
          subTextPosition: spec.subTextPosition,
          autoFit: spec.autoFit,
          color: spec.color,
          align: spec.align,
        })
        // Promote both overflow and auto-expand to warnings.
        // autoExpandedBy reports how much autoFit stretched the box.
        if (diag.overflow || (diag.autoExpandedBy ?? 0) > 0) {
          return [{ index, ...diag }]
        }
        return []
      }))

      const doc = await apiGetSnapshot(client, workspaceId, slug)
      const prevVV = doc.version()
      const workingDoc = args.dryRun === true
        ? LoroDoc.fromSnapshot(doc.export({ mode: 'snapshot' }))
        : doc
      // Layer 3: collect group missingMemberIds using the snapshot before any doc writes.
      // Continue even if every memberId is missing; appendAnnotationToDoc will skip rect creation.
      const elementsSnapshot = doc.getMovableList('elements').toJSON() as Array<{
        id: string
        x: number
        y: number
        width: number
        height: number
        isDeleted?: boolean
      }>
      resolvedSpecs.forEach((spec, index) => {
        if (spec.type !== 'group') return
        const [, , diag] = decomposeGroup({
          elements: elementsSnapshot,
          memberIds: spec.memberIds ?? [],
          padding: spec.padding,
          title: spec.title,
          color: spec.color,
        })
        if (diag.missingMemberIds.length > 0) {
          warnings.push({ index, missingMemberIds: diag.missingMemberIds })
        }
      })
      // Return structured per-spec results in annotations[].
      // Keep elementIds flattened for backward compatibility.
      // binding-name DSL resolves arrow startBoxName/endBoxName from earlier
      // annotation names to rectId or elementId, in declaration order only.
      const nameToRef = new Map<string, string>()
      const annotations: AnnotationResult[] = resolvedSpecs.map((spec, index) => {
        const binding = bindings[index]
        let effectiveSpec: AnnotationSpec = spec
        if (spec.type === 'arrow' && (binding?.startBoxName || binding?.endBoxName)) {
          const unresolved: string[] = []
          const patch: { startBoxId?: string; endBoxId?: string } = {}
          if (binding.startBoxName) {
            const ref = nameToRef.get(binding.startBoxName)
            if (ref) patch.startBoxId = ref
            else unresolved.push(binding.startBoxName)
          }
          if (binding.endBoxName) {
            const ref = nameToRef.get(binding.endBoxName)
            if (ref) patch.endBoxId = ref
            else unresolved.push(binding.endBoxName)
          }
          if (unresolved.length > 0) {
            warnings.push({ index, unresolvedBindingName: unresolved })
          }
          effectiveSpec = { ...spec, ...patch }
        }
        const result = appendAnnotationToDoc(workingDoc, effectiveSpec)
        if (binding?.name) {
          // Register rectId for box_with_label and elementId for other types.
          const ref = result.rectId ?? result.elementId
          if (ref) nameToRef.set(binding.name, ref)
        }
        return result
      })
      const elementIds = annotations.flatMap(flattenAnnotationResult)
      if (args.groupAs) {
        applyAssignToGroup(workingDoc, args.groupAs, elementIds)
      }
      const snapshotElements = workingDoc.getMovableList('elements').toJSON() as Array<Record<string, unknown>>
      const byElementId = new Map(
        snapshotElements
          .filter((element) => typeof element.id === 'string')
          .map((element) => [element.id as string, element]),
      )
      const placements = annotations.map((annotation, annotationIndex) => {
        const anchorId =
          annotation.rectId ??
          annotation.elementId ??
          annotation.arrowId
        const element = anchorId ? byElementId.get(anchorId) : undefined
        return {
          annotationIndex,
          rect: {
            x: (element?.x as number | undefined) ?? 0,
            y: (element?.y as number | undefined) ?? 0,
            width: (element?.width as number | undefined) ?? 0,
            height: (element?.height as number | undefined) ?? 0,
          },
          ...(args.dryRun ? {} : anchorId ? { elementId: anchorId } : {}),
        }
      })
      const overlapThreshold = args.overlapThreshold ?? 0.1
      const overlaps: Array<{ a: number; b: number; iou: number }> = []
      // Also surface overlaps as warnings; keeping them only in placements is easy to miss.
      // Collapse multiple overlaps for the same index into one warning.
      const overlapPartners = new Map<number, number[]>()
      for (let a = 0; a < placements.length; a++) {
        for (let b = a + 1; b < placements.length; b++) {
          const iou = computeIou(placements[a].rect, placements[b].rect)
          if (iou > overlapThreshold) {
            overlaps.push({ a, b, iou })
            if (!overlapPartners.has(a)) overlapPartners.set(a, [])
            if (!overlapPartners.has(b)) overlapPartners.set(b, [])
            overlapPartners.get(a)!.push(b)
            overlapPartners.get(b)!.push(a)
          }
        }
      }
      // Expose name -> AnnotationResult so callers can later update just the label text,
      // for example via update_element. Duplicate names use last-write-wins in declaration order.
      const byName: Record<string, AnnotationResult> = {}
      for (let i = 0; i < annotations.length; i++) {
        const name = bindings[i]?.name
        if (name) byName[name] = annotations[i]
      }
      if (args.dryRun !== true) {
        workingDoc.commit()
        await apiPostLoroUpdate(
          client,
          workspaceId,
          slug,
          workingDoc.export({ mode: 'update', from: prevVV }),
        )
      }
      // Elevate overlaps into warnings[] and collapse collisions by index.
      for (const [idx, partners] of overlapPartners) {
        const uniq = Array.from(new Set(partners)).sort((a, b) => a - b)
        warnings.push({
          index: idx,
          message: `overlaps annotation${uniq.length === 1 ? '' : 's'} ${uniq.join(', ')} (IoU > ${overlapThreshold})`,
        })
      }
      return { elementIds, annotations, warnings, byName, placements, overlaps }
    },
  }
}
