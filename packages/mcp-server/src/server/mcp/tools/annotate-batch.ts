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
import { assertCanvasExists } from './canvas-existence.js'
import { parseCanvasId } from './canvas-id.js'
import { applyAssignToGroup } from './element-ops.js'
import { decomposeGroup } from './group.js'
import { type GridLayout, resolveGridPlacement, resolveLayout } from './resolve-layout.js'
import { boundsSchema } from './shared-schemas.js'

const annotateBatchWarningSchema = z.object({
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
interface AnnotationWarning {
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
  groupAs?: string
}

export const annotateBatchInputShape = {
  canvasId: z.string().describe('Canvas ID in "{workspaceId}/{slug}" form.'),
  layout: z
    .object({
      cols: z.number().describe('Number of grid columns.'),
      rows: z.number().describe('Number of grid rows.'),
      cellW: z
        .number()
        .optional()
        .describe('Default cell width (px). Used when colWidths is not specified.'),
      cellH: z
        .number()
        .optional()
        .describe('Default cell height (px). Used when rowHeights is not specified.'),
      colWidths: z
        .array(z.number())
        .optional()
        .describe(
          'Per-column widths (px). Length must match cols. Use for unequal column widths in comparison matrices.',
        ),
      rowHeights: z
        .array(z.number())
        .optional()
        .describe('Per-row heights (px). Length must match rows.'),
      gap: z.number().describe('Gap between cells (px).'),
      origin: z
        .object({ x: z.number(), y: z.number() })
        .describe('Top-left corner of the grid in world coords.'),
    })
    .optional()
    .describe(
      'Optional grid layout. When set, items use row/col/rowSpan/colSpan to position. When omitted, items use absolute target coords. Avoid mixing layout with banner/footer extras (use absolute coords for those).',
    ),
  dryRun: z
    .boolean()
    .optional()
    .describe(
      'When true, return placements + warnings without committing to canvas. Use to preview overlaps before applying. Default false.',
    ),
  overlapThreshold: z
    .number()
    .optional()
    .describe(
      'IoU threshold (0..1) above which placements are flagged as overlapping in warnings. Default 0.05.',
    ),
  groupAs: z
    .string()
    .optional()
    .describe(
      'Optional batch-level group label applied to all created elements. Per-item annotations[].groupAs adds an additional, item-scoped group on top of this one (not a replacement).',
    ),
  annotations: z
    .array(
      z.object({
        type: z
          .enum(['arrow', 'text', 'rectangle', 'highlight', 'box_with_label', 'group'])
          .describe('Annotation kind. Same vocabulary as annotate tool.'),
        imageId: z
          .string()
          .optional()
          .describe(
            'When set, target/endTarget are interpreted relative to the named image (use load_image first). Use with coords="relative".',
          ),
        coords: z
          .enum(['absolute', 'relative'])
          .optional()
          .describe(
            'Coord space. With grid layout, ignored (row/col is used). Default "absolute".',
          ),
        target: z
          .object({ x: z.number(), y: z.number() })
          .optional()
          .describe('Absolute / relative position when not using grid layout.'),
        row: z
          .number()
          .optional()
          .describe('Grid row index (0-based). Required when layout is set.'),
        col: z
          .number()
          .optional()
          .describe('Grid column index (0-based). Required when layout is set.'),
        rowSpan: z.number().optional().describe('Number of rows this cell spans. Default 1.'),
        colSpan: z.number().optional().describe('Number of columns this cell spans. Default 1.'),
        text: z
          .union([z.string(), z.array(z.string())])
          .optional()
          .describe(
            'Text content. string for single line, string[] for multi-line (joined with "\\n"). box_with_label centers multi-line vertically and does NOT auto-wrap — pre-split long text into string[] to fit within width/cellW. For arrow type, text is an alias for label (midpoint label text node); label takes precedence when both are supplied.',
          ),
        title: z
          .union([z.string(), z.array(z.string())])
          .optional()
          .describe(
            'box_with_label/group only: title text. box_with_label renders it above the body inside the box; group renders it above the bounding rect.',
          ),
        subText: z
          .union([z.string(), z.array(z.string())])
          .optional()
          .describe(
            'box_with_label only: caption rendered as a separate 14px text element. Placement controlled by subTextPosition. string for single line, string[] for multi-line.',
          ),
        subTextPosition: z
          .enum(['top', 'inside-bottom'])
          .optional()
          .describe(
            'box_with_label only: subText placement. Default is "inside-bottom" = bottom half inside the rect (main/sub both free-floating, center-aligned). Use "top" for a caption above the rect.',
          ),
        autoFit: z
          .boolean()
          .optional()
          .describe(
            'box_with_label only: auto-fit box height to text. Default true (ON). Pass false to opt out — box keeps the caller-specified height and overflow is reported as a warning.',
          ),
        color: z.string().optional().describe('Stroke color as hex (#RRGGBB).'),
        backgroundColor: z
          .string()
          .optional()
          .describe(
            'Fill color for rectangle / box_with_label / highlight / arrow as hex (#RRGGBB). Default: transparent for rect/box, strokeColor for highlight. Pair with fillStyle=solid for filled box.',
          ),
        fillStyle: z
          .enum(['solid', 'hachure', 'cross-hatch'])
          .optional()
          .describe(
            'Fill pattern for rectangle / box_with_label / highlight. Default: hachure (rect/box) / solid (highlight).',
          ),
        strokeWidth: z
          .number()
          .optional()
          .describe('Stroke line width. Default 2. Useful on arrow to emphasize flow.'),
        fontFamily: z
          .union([
            z.literal(1),
            z.literal(2),
            z.literal(3),
            z.literal(5),
            z.literal(6),
            z.literal(7),
            z.literal(8),
            z.literal(9),
          ])
          .optional()
          .describe(
            'Text font family. Current: 5 = Excalifont (hand-drawn, default), 6 = Nunito (sans), 7 = "Lilita One" (display), 8 = "Comic Shanns" (monospace, for paths / identifiers / code), 9 = "Liberation Sans". Legacy: 1 = Virgil, 2 = Helvetica, 3 = Cascadia (UI marks "old"). Use 8 for system paths and 5 for human annotations to create visual contrast.',
          ),
        fontSize: z.number().optional().describe('text only: explicit font size in px.'),
        width: z
          .number()
          .optional()
          .describe(
            'Box width in px (rectangle / highlight / box_with_label). Required for accurate text wrap. With grid layout, defaults to the cell width when omitted.',
          ),
        height: z
          .number()
          .optional()
          .describe(
            'Box height in px. With autoFit=true, used as a minimum (grows if text overflows). With grid layout, defaults to the cell height when omitted.',
          ),
        align: z
          .enum(['left', 'center', 'right'])
          .optional()
          .describe(
            'text only: horizontal alignment. With width, target becomes the anchor (center → target.x is the block center, right → target.x is the right edge).',
          ),
        endTarget: z
          .object({ x: z.number(), y: z.number() })
          .optional()
          .describe('Arrow end point. Required when type="arrow" and endBoxId is not set.'),
        startBoxId: z
          .string()
          .optional()
          .describe(
            'arrow only: element id whose rect is used to snap the start point to its nearest edge.',
          ),
        endBoxId: z
          .string()
          .optional()
          .describe(
            'arrow only: element id whose rect is used to snap the end point to its nearest edge.',
          ),
        label: z
          .string()
          .optional()
          .describe(
            'arrow only: label text placed at the midpoint of the (snap-applied) arrow. Adds a text element above the line.',
          ),
        labelOffset: z
          .number()
          .optional()
          .describe(
            'arrow.label only: perpendicular distance from the line to the label center (default 6).',
          ),
        labelSide: z
          .enum(['auto', 'above', 'below', 'left', 'right'])
          .optional()
          .describe(
            'arrow.label only: which side of the line to place the label. "auto" (default) = upper side. Geometrically indeterminate combinations (horizontal + left/right, vertical + above/below) fall back to auto.',
          ),
        memberIds: z
          .array(z.string())
          .optional()
          .describe(
            'group only: element ids to enclose. The bounding rect is computed from existing non-deleted members (missing/deleted ids reported in warnings).',
          ),
        padding: z
          .number()
          .optional()
          .describe('group only: padding (px) added around the bbox (default 20).'),
        name: z
          .string()
          .optional()
          .describe(
            'Label this annotation so later arrows can reference it via startBoxName/endBoxName without knowing the generated id. For box_with_label resolves to rectId; for rectangle/text/highlight resolves to elementId.',
          ),
        startBoxName: z
          .string()
          .optional()
          .describe(
            'arrow only: resolve to the rectId of a preceding annotation with the matching name. Takes precedence over startBoxId. Unresolved names are reported in warnings[].unresolvedBindingName.',
          ),
        endBoxName: z
          .string()
          .optional()
          .describe(
            'arrow only: resolve to the rectId of a preceding annotation with the matching name. Takes precedence over endBoxId. Unresolved names are reported in warnings[].unresolvedBindingName.',
          ),
        groupAs: z
          .string()
          .optional()
          .describe(
            'Per-item group label, applied in addition to the batch-level groupAs (if both are set, this item ends up in both groups). Use to carve out a sub-group within a larger batch, e.g. one row of a comparison grid.',
          ),
      }),
    )
    .min(1)
    .describe(
      'Annotation items in this batch. Created in 1 snapshot/commit/broadcast. Each item has the same fields as `annotate` plus row/col/rowSpan/colSpan for grid layout and name/startBoxName/endBoxName for cross-item snap.',
    ),
} satisfies z.ZodRawShape

// Apply many annotations with one snapshot fetch, one commit, and one update POST.
// This is much cheaper than calling annotate repeatedly for diagram-heavy flows.
export function annotateBatchTool() {
  return {
    name: 'annotate_batch',
    description:
      'Add multiple annotations in one request (single snapshot fetch, single commit, single broadcast). Supports optional grid layout for matrix/comparison diagrams. IMPORTANT: box_with_label does NOT auto-wrap long text; the caller must pre-split long lines by passing text as string[] (each element = 1 line) so the label fits within width/cellW.',
    // Derived from the Zod shape so the JSON-Schema view can never drift from
    // what registerToolWithAnnotations actually validates against.
    inputSchema: z.toJSONSchema(z.object(annotateBatchInputShape)) as {
      type: 'object'
      properties: Record<string, unknown>
      required?: string[]
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
    ): Promise<z.infer<typeof annotateBatchOutputSchema>> => {
      const { workspaceId, slug } = parseCanvasId(args.canvasId)
      await assertCanvasExists(client, workspaceId, slug)
      const warnings: AnnotationWarning[] = []
      // Layer 1: resolve targets for items that need layout before touching the doc.
      // Fail fast before fetching a snapshot if layout resolution fails.
      // group does not use target, so skip resolveLayout and supply a fallback.
      // Preserve name/startBoxName/endBoxName for later binding-name resolution.
      const bindings: Array<{
        name?: string
        startBoxName?: string
        endBoxName?: string
        groupAs?: string
      }> = []
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
        const {
          row: _r,
          col: _c,
          rowSpan: _rs,
          colSpan: _cs,
          name,
          startBoxName,
          endBoxName,
          groupAs: itemGroupAs,
          ...rest
        } = item
        bindings.push({ name, startBoxName, endBoxName, groupAs: itemGroupAs })
        return { ...rest, target, width, height } as AnnotationSpec
      })
      // Layer 2: collect box_with_label overflow diagnostics without touching the doc.
      // decomposeBoxWithLabel returns [rect, text, diagnostics], so only diagnostics matter here.
      // Specs missing width/height/text are rejected later by appendAnnotationToDoc, so skip them here.
      warnings.push(
        ...resolvedSpecs.flatMap((spec, index) => {
          if (spec.type !== 'box_with_label') return []
          if (
            (spec.text === undefined && spec.title === undefined) ||
            spec.width === undefined ||
            (spec.height === undefined && spec.autoFit === false)
          ) {
            return []
          }
          const [, , diag] = decomposeBoxWithLabel({
            target: spec.target,
            width: spec.width,
            height: spec.height ?? 0,
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
        }),
      )

      const doc = await apiGetSnapshot(client, workspaceId, slug)
      const prevVV = doc.version()
      const workingDoc =
        args.dryRun === true ? LoroDoc.fromSnapshot(doc.export({ mode: 'snapshot' })) : doc
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
      // Per-item groupAs is additive on top of the batch-level group: an item
      // with its own groupAs ends up in both the shared batch group and its
      // own sub-group.
      for (let index = 0; index < annotations.length; index++) {
        const itemGroupAs = bindings[index]?.groupAs
        if (!itemGroupAs) continue
        const itemElementIds = flattenAnnotationResult(annotations[index])
        applyAssignToGroup(workingDoc, itemGroupAs, itemElementIds)
      }
      const snapshotElements = workingDoc.getMovableList('elements').toJSON() as Array<
        Record<string, unknown>
      >
      const byElementId = new Map(
        snapshotElements
          .filter((element) => typeof element.id === 'string')
          .map((element) => [element.id as string, element]),
      )
      const placements = annotations.map((annotation, annotationIndex) => {
        const anchorId = annotation.rectId ?? annotation.elementId ?? annotation.arrowId
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
      return {
        elementIds,
        annotations,
        warnings,
        byName,
        placements,
        overlaps,
      }
    },
  }
}
