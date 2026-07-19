import { LoroDoc, LoroMap } from 'loro-crdt'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import type { DaemonClient } from '../daemon-client.js'
import {
  type AnnotationFields,
  type AnnotationType,
  buildAnnotationFields,
} from './annotation-fields.js'
import { decomposeBoxWithLabel, type SubTextPosition } from './box-with-label.js'
import { assertCanvasExists } from './canvas-existence.js'
import { parseCanvasId } from './canvas-id.js'
import {
  contrastRatio,
  isExplicitHexColor,
  readableInkForFill,
  resolvePaletteColor,
} from './color-palette.js'
import { decomposeGroup } from './group.js'
import { apiGetPalette } from './palette.js'
import { resolveAnnotationPosition, type CoordsMode } from './resolve-annotation-position.js'
import { resolveArrowLabelPosition } from './resolve-arrow-label-position.js'
import { resolveArrowRoute } from './resolve-arrow-route.js'
import { resolveTextPosition, type TextAlign } from './resolve-text-position.js'
import { snapArrowEndpoints, type Rect } from './snap-arrow.js'

// Shared annotation result shape (also re-used by annotate-batch).
export const annotationResultSchema = z.object({
  type: z.enum(['arrow', 'text', 'rectangle', 'highlight', 'box_with_label', 'group']),
  elementId: z.string().optional(),
  arrowId: z.string().optional(),
  labelId: z.string().optional(),
  rectId: z.string().optional(),
  textId: z.string().optional(),
  subTextId: z.string().optional(),
  titleId: z.string().optional(),
})

const annotateWarningSchema = z.object({
  overflow: z.boolean().optional(),
  requiredWidth: z.number().optional(),
  requiredHeight: z.number().optional(),
})

export const annotateOutputSchema = z.object({
  elementId: z.string().optional(),
  elementIds: z.array(z.string()).optional(),
  annotation: annotationResultSchema,
  warnings: z.array(annotateWarningSchema),
  unknownPaletteKeys: z.array(z.string()).optional(),
})

// Single source of truth for the `annotate` tool's input contract: the raw
// shape below is what registerToolWithAnnotations (tool-registration.ts)
// hands to the MCP SDK for per-field validation and tools/list JSON Schema
// generation, and annotateInputSchema (derived from it, below) adds the
// cross-field check that a ZodRawShape cannot express on its own.
export const annotateInputShape = {
  canvasId: z.string().describe('Canvas ID in "{workspaceId}/{slug}" form.'),
  type: z
    .enum(['arrow', 'text', 'rectangle', 'highlight', 'box_with_label', 'group'])
    .describe(
      'Annotation kind. arrow = directed arrow, text = standalone label, rectangle = empty box, highlight = filled background, box_with_label = box + auto-wrapped title/subText, group = bbox+title around existing memberIds.',
    ),
  imageId: z
    .string()
    .optional()
    .describe(
      'When set, target/endTarget are interpreted relative to the named image (use load_image first). Use with coords="relative".',
    ),
  coords: z
    .enum(['absolute', 'relative', 'parent'])
    .optional()
    .describe(
      'Coordinate space. "absolute" (default) = world coords. "relative" = offset from imageId. "parent" = offset from a parent element (defer-resolved at apply-time, used for sticky annotations on moving parents).',
    ),
  target: z
    .object({ x: z.number(), y: z.number() })
    .optional()
    .describe(
      'Top-left corner of the element in chosen coord space. For arrows this is the start point — required unless startBoxId is set (startBoxId snaps the start to an existing box edge instead). Ignored for type="group".',
    ),
  text: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe(
      'Body text. string[] for explicit line breaks; long lines auto-wrap to box width when autoFit=true.',
    ),
  title: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe(
      'Header text rendered larger than text. Used by box_with_label to separate title from body.',
    ),
  subText: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe(
      'Smaller secondary text. Default position is below the box (inside-bottom). Use subTextPosition="top" for above-box captions.',
    ),
  subTextPosition: z
    .enum(['top', 'inside-bottom'])
    .optional()
    .describe('Where subText is placed relative to box_with_label. Default "inside-bottom".'),
  autoFit: z
    .boolean()
    .optional()
    .describe(
      'Auto-wrap long lines and auto-grow box height. Default true. Set false to honor explicit string[] line breaks strictly.',
    ),
  color: z
    .string()
    .optional()
    .describe(
      'Stroke / text color. Accepts semantic keys ("primary","success","danger","warning","neutral","info") or palette key (declared via palette_set) or hex (#RRGGBB). For box_with_label on a solid fill, a semantic/palette text ink that would be unreadable against the fill is auto-adjusted for contrast; pass an explicit hex to opt out.',
    ),
  backgroundColor: z
    .string()
    .optional()
    .describe(
      'Fill color (rectangle / highlight / box_with_label background). Same key vocabulary as `color`.',
    ),
  fillStyle: z
    .enum(['solid', 'hachure', 'cross-hatch'])
    .optional()
    .describe('Fill pattern for box / highlight. Default Excalidraw default ("hachure").'),
  strokeWidth: z.number().optional().describe('Line thickness in px. Default 2.'),
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
      'Excalidraw font family enum (1=Virgil/hand-drawn, 2=Helvetica, 3=Cascadia/mono, 5-9 = additional families). Default 1.',
    ),
  fontSize: z.number().optional().describe('Text size in px. Default 20.'),
  width: z
    .number()
    .optional()
    .describe(
      'Box width in px (rectangle / highlight / box_with_label). Required for accurate text wrap.',
    ),
  height: z
    .number()
    .optional()
    .describe('Box height in px. With autoFit=true, used as a minimum (grows if text overflows).'),
  align: z
    .enum(['left', 'center', 'right'])
    .optional()
    .describe('Horizontal text alignment inside box_with_label / text. Default "left".'),
  endTarget: z
    .object({ x: z.number(), y: z.number() })
    .optional()
    .describe('Arrow end point. Required when type="arrow" and endBoxId is not set.'),
  startBoxId: z
    .string()
    .optional()
    .describe(
      'Arrow start: snap to the named box edge instead of using `target`. Convenient for connecting existing elements.',
    ),
  endBoxId: z
    .string()
    .optional()
    .describe('Arrow end: snap to the named box edge instead of using `endTarget`.'),
  label: z.string().optional().describe('Inline label rendered along the arrow midpoint.'),
  labelOffset: z
    .number()
    .optional()
    .describe('Perpendicular offset (px) from arrow path for the label. Default 8.'),
  labelSide: z
    .enum(['auto', 'above', 'below', 'left', 'right'])
    .optional()
    .describe(
      'Side of arrow path where label sits. "auto" picks the less-crowded side. Default "auto".',
    ),
  memberIds: z
    .array(z.string())
    .optional()
    .describe('For type="group": ids of existing elements to wrap with a labeled bbox.'),
  padding: z
    .number()
    .optional()
    .describe('For type="group": extra padding (px) around the member bbox. Default 16.'),
} satisfies z.ZodRawShape

// Cross-field check a ZodRawShape cannot express: `target` is required
// UNLESS the caller supplied a way to derive the start point without it
// (startBoxId for arrows, or type="group" which ignores target entirely and
// defaults it internally). Runs inside `execute` (see below) since the MCP
// SDK validates only the raw per-field shape above, not this schema.
export const annotateInputSchema = z.object(annotateInputShape).superRefine((data, ctx) => {
  if (data.type === 'group') return
  if (data.type === 'arrow') {
    if (data.target === undefined && data.startBoxId === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['target'],
        message:
          'annotate type="arrow" requires either `target` (explicit start point) or `startBoxId` (snaps the start to an existing box edge).',
      })
    }
    return
  }
  if (data.target === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['target'],
      message: `annotate type="${data.type}" requires \`target\`.`,
    })
  }
})

// box_with_label and group are composite types accepted only by the public
// annotate API. Internally they are decomposed into primitive elements.
type AnnotatePublicType = AnnotationType | 'box_with_label' | 'group'

interface ExcalidrawElement {
  id: string
  type: string
  x: number
  y: number
  width: number
  height: number
  fileId?: string
  isDeleted?: boolean
  boundElements?: Array<{ id: string; type: string }> | null
  // Points at the parent rectangle for bound text. Only meaningful on text.
  containerId?: string | null
  // Marks text that was auto-generated as an arrow midpoint label.
  isArrowLabel?: boolean
}

const DEFAULT_COLORS: Record<AnnotationType, string> = {
  arrow: '#e03131',
  text: '#1e1e2e',
  rectangle: '#e03131',
  highlight: '#f08c00',
}

export interface AnnotationSpec {
  type: AnnotatePublicType
  imageId?: string
  coords?: CoordsMode
  target: { x: number; y: number }
  // Use string for a single line and string[] for multiple lines. box_with_label
  // centers each line, while other text/arrow annotations join lines with "\n".
  text?: string | string[]
  // box_with_label only: renders a separate 14px caption-like text element.
  // By default it stays inside the box bottom area; "top" places it above.
  subText?: string | string[]
  // box_with_label only: subText placement. "inside-bottom" splits the box into
  // main/sub zones and leaves both as free-floating centered text. "top" uses
  // the legacy caption-above-box placement.
  subTextPosition?: SubTextPosition
  // box_with_label only: auto-expand height when overflow is detected. This is
  // enabled by default; pass false only to opt out.
  autoFit?: boolean
  color?: string
  // Visual style overrides for rectangle / box_with_label / highlight / arrow.
  backgroundColor?: string
  fillStyle?: 'solid' | 'hachure' | 'cross-hatch'
  strokeWidth?: number
  // Shared ID attached by template_insert. Composite annotations propagate it
  // to all decomposed children.
  templateInstanceId?: string
  // Internal-use marker for text created as an arrow midpoint label.
  isArrowLabel?: boolean
  width?: number
  height?: number
  // text only: horizontal alignment. With width, target becomes the anchor:
  // left = left edge, center = midpoint, right = right edge.
  align?: TextAlign
  // arrow only: end point interpreted with the same coords mode as target.
  endTarget?: { x: number; y: number }
  // arrow only: snap start/end to the nearest edge of existing rectangles.
  startBoxId?: string
  endBoxId?: string
  // arrow only: label text placed near the midpoint of the snapped arrow.
  label?: string
  // arrow label only: normal-direction offset from the line. Default 6px.
  labelOffset?: number
  // arrow label only: placement side. "auto" chooses above for horizontals and
  // the visually upper side for diagonals.
  labelSide?: 'auto' | 'above' | 'below' | 'left' | 'right'
  // group only: ids of elements to enclose in a generated bounding rectangle.
  memberIds?: string[]
  // group only: padding around the computed bounding box. Default 20px.
  padding?: number
  // group only: optional 14px title rendered above the rectangle.
  title?: string | string[]
  // Excalidraw fontFamily propagated to text, box_with_label, group titles,
  // and arrow labels.
  fontFamily?: 1 | 2 | 3 | 5 | 6 | 7 | 8 | 9
  fontSize?: number
  sessionPalette?: Record<string, string>
}

// Resolve a rectangle from an element id. Deleted or missing ids return
// undefined so callers can skip snapping.
function findRectForSnap(
  elements: ExcalidrawElement[],
  id: string | undefined,
): { rect: Rect; bindingElementId: string } | undefined {
  if (!id) return undefined
  const el = elements.find((e) => e.id === id && !e.isDeleted)
  if (!el) return undefined
  if (el.type === 'text' && el.containerId) {
    const container = elements.find(
      (candidate) => candidate.id === el.containerId && !candidate.isDeleted,
    )
    if (container) {
      return {
        rect: { x: container.x, y: container.y, width: container.width, height: container.height },
        bindingElementId: container.id,
      }
    }
  }
  return {
    rect: { x: el.x, y: el.y, width: el.width, height: el.height },
    bindingElementId: el.id,
  }
}

function findElementMap(doc: LoroDoc, elementId: string): LoroMap | undefined {
  const list = doc.getMovableList('elements')
  for (let i = 0; i < list.length; i++) {
    const map = list.get(i)
    if (!(map instanceof LoroMap)) continue
    if (map.get('id') === elementId) return map
  }
  return undefined
}

// Append a single primitive annotation and return its element id plus snapped
// endpoints when applicable.
function appendSingleAnnotation(
  doc: LoroDoc,
  spec: AnnotationSpec & { type: AnnotationType },
): {
  elementId: string
  snappedStart: { x: number; y: number }
  snappedEnd?: { x: number; y: number }
} {
  const elements = doc.getMovableList('elements').toJSON() as ExcalidrawElement[]
  const resolved = resolveAnnotationPosition(
    { coords: spec.coords, imageId: spec.imageId, target: spec.target },
    elements,
  )
  const { x: anchorX, y: anchorY } = resolved
  // Only text resolves anchor semantics. Other types keep target as top-left.
  const textAnchor =
    spec.type === 'text'
      ? resolveTextPosition({
          target: { x: anchorX, y: anchorY },
          width: spec.width,
          align: spec.align,
        })
      : null
  const actualX = textAnchor?.x ?? anchorX
  const actualY = textAnchor?.y ?? anchorY
  const elementId = nanoid()
  const strokeColor = spec.color
    ? resolvePaletteColor(spec.color, spec.sessionPalette ?? {}).color
    : DEFAULT_COLORS[spec.type]
  const absoluteEndTarget = spec.endTarget
    ? resolveAnnotationPosition(
        { coords: spec.coords, imageId: spec.imageId, target: spec.endTarget },
        elements,
      )
    : undefined
  // Snap arrow endpoints to rectangle edges in absolute coordinates. If a box
  // is provided, its center becomes the aim point; otherwise the caller-supplied
  // target/endTarget is used.
  let snappedStart = { x: actualX, y: actualY }
  let snappedEnd = absoluteEndTarget
  let startBindingElementId: string | undefined
  let endBindingElementId: string | undefined
  if (spec.type === 'arrow') {
    const startTarget = findRectForSnap(elements, spec.startBoxId)
    const endTarget = findRectForSnap(elements, spec.endBoxId)
    const startBox = startTarget?.rect
    const endBox = endTarget?.rect
    startBindingElementId = startTarget?.bindingElementId
    endBindingElementId = endTarget?.bindingElementId
    if (startBox) {
      snappedStart = {
        x: startBox.x + startBox.width / 2,
        y: startBox.y + startBox.height / 2,
      }
    }
    if (endBox) {
      snappedEnd = {
        x: endBox.x + endBox.width / 2,
        y: endBox.y + endBox.height / 2,
      }
    }
    if (snappedEnd) {
      const snapped = snapArrowEndpoints({
        start: snappedStart,
        end: snappedEnd,
        startBox,
        endBox,
      })
      snappedStart = snapped.start
      snappedEnd = snapped.end
    }
  }
  // Orthogonal arrow routing. Start/end boxes are excluded because they are the
  // intended connection targets. Other boxes/text/ellipse/diamond elements act
  // as obstacles.
  let routedPoints: [number, number][] | undefined
  if (spec.type === 'arrow' && snappedEnd) {
    // Ignore existing arrow labels and the bound text of the start/end boxes so
    // routing does not double-count those rectangles as obstacles.
    const routeObstacles = elements
      .filter((el) => el.isDeleted !== true)
      .filter((el) => el.id !== spec.startBoxId && el.id !== spec.endBoxId)
      .filter((el) => el.isArrowLabel !== true)
      .filter(
        (el) =>
          !(
            el.type === 'text' &&
            el.containerId !== undefined &&
            el.containerId !== null &&
            (el.containerId === spec.startBoxId || el.containerId === spec.endBoxId)
          ),
      )
      .filter(
        (el) =>
          el.type === 'rectangle' ||
          el.type === 'text' ||
          el.type === 'ellipse' ||
          el.type === 'diamond',
      )
      .map((el) => ({ x: el.x, y: el.y, width: el.width, height: el.height }))
    const { points } = resolveArrowRoute({
      start: snappedStart,
      end: snappedEnd,
      obstacles: routeObstacles,
    })
    routedPoints = points
  }
  // Arrays are joined into one text element with "\n".
  const textValue = Array.isArray(spec.text) ? spec.text.join('\n') : spec.text
  const fields = buildAnnotationFields({
    elementId,
    type: spec.type,
    x: snappedStart.x,
    y: snappedStart.y,
    strokeColor,
    now: Date.now(),
    seed: Math.floor(Math.random() * 1000000),
    versionNonce: Math.floor(Math.random() * 1000000),
    text: textValue,
    width: spec.width,
    height: spec.height,
    textAlign: textAnchor?.textAlign,
    endTarget: snappedEnd,
    points: routedPoints,
    backgroundColor: spec.backgroundColor
      ? resolvePaletteColor(spec.backgroundColor, spec.sessionPalette ?? {}).color
      : undefined,
    fillStyle: spec.fillStyle,
    strokeWidth: spec.strokeWidth,
    templateInstanceId: spec.templateInstanceId,
    isArrowLabel: spec.isArrowLabel,
    fontFamily: spec.fontFamily,
    fontSize: spec.fontSize,
    preserveLineBreaks: Array.isArray(spec.text),
  })
  const list = doc.getMovableList('elements')
  const map = list.insertContainer(list.length, new LoroMap())
  for (const [key, value] of Object.entries(fields satisfies AnnotationFields)) {
    map.set(key, value as Parameters<LoroMap['set']>[1])
  }
  // For coords:'parent', persist parent-follow metadata. resolveParentedElements
  // re-resolves it before render/export, while x/y keep the latest absolute
  // fallback if the parent disappears.
  if (resolved.parentId !== undefined) {
    map.set('parentId', resolved.parentId)
    map.set('relX', resolved.relX as number)
    map.set('relY', resolved.relY as number)
  }
  if (spec.type === 'arrow') {
    if (startBindingElementId) map.set('startBoxId', startBindingElementId)
    if (endBindingElementId) map.set('endBoxId', endBindingElementId)
    const pushBoundArrow = (targetId: string | undefined) => {
      if (!targetId) return
      const targetMap = findElementMap(doc, targetId)
      if (!targetMap) return
      const current = targetMap.get('boundElements')
      const next = Array.isArray(current) ? [...current] : []
      if (!next.some((entry) => entry?.id === elementId && entry?.type === 'arrow')) {
        next.push({ id: elementId, type: 'arrow' })
        targetMap.set('boundElements', next as Parameters<LoroMap['set']>[1])
      }
    }
    pushBoundArrow(startBindingElementId)
    pushBoundArrow(endBindingElementId)
  }
  return { elementId, snappedStart, snappedEnd }
}

// Structured result for appended annotations so callers can reference internal
// ids of composite elements while preserving backward-compatible elementIds.
export interface AnnotationResult {
  // Echo the requested annotation type, including composite types.
  type: AnnotationType | 'box_with_label' | 'group'
  // Single element id for primitive rectangle / text / highlight annotations.
  elementId?: string
  // Arrow body id.
  arrowId?: string
  // Text id generated for an arrow label.
  labelId?: string
  // Rectangle id for box_with_label / group.
  rectId?: string
  // Main text id for box_with_label.
  textId?: string
  // Optional subText id for box_with_label.
  subTextId?: string
  // Optional title id for group / box_with_label.
  titleId?: string
}

// Flatten AnnotationResult into the legacy string[] shape in deterministic order.
export function flattenAnnotationResult(r: AnnotationResult): string[] {
  const ids: string[] = []
  if (r.rectId) ids.push(r.rectId)
  if (r.titleId) ids.push(r.titleId)
  if (r.textId) ids.push(r.textId)
  if (r.subTextId) ids.push(r.subTextId)
  if (r.arrowId) ids.push(r.arrowId)
  if (r.labelId) ids.push(r.labelId)
  if (r.elementId) ids.push(r.elementId)
  return ids
}

// Append one annotation spec to the doc. Composite decomposition happens here;
// snapshot fetch / commit / update post stay with the caller.
export function appendAnnotationToDoc(doc: LoroDoc, spec: AnnotationSpec): AnnotationResult {
  if (spec.type === 'group') {
    // Build the group rectangle from existing element bounds. annotate_batch
    // reports missingMemberIds separately; the single annotate API does not.
    const elements = doc.getMovableList('elements').toJSON() as ExcalidrawElement[]
    const [rectSpec, titleSpec] = decomposeGroup({
      elements,
      memberIds: spec.memberIds ?? [],
      padding: spec.padding,
      title: spec.title,
      color: spec.color,
      templateInstanceId: spec.templateInstanceId,
    })
    if (!rectSpec) return { type: 'group' }
    const { elementId: rectId } = appendSingleAnnotation(doc, {
      ...rectSpec,
      coords: 'absolute',
      sessionPalette: spec.sessionPalette,
    })
    if (!titleSpec) return { type: 'group', rectId }
    const { elementId: titleId } = appendSingleAnnotation(doc, {
      ...titleSpec,
      coords: 'absolute',
      sessionPalette: spec.sessionPalette,
    })
    return { type: 'group', rectId, titleId }
  }

  if (spec.type !== 'box_with_label') {
    const primitiveSpec = spec as AnnotationSpec & { type: AnnotationType }
    // For arrow specs, `text` is an alias for `label` (midpoint label text node).
    // `label` takes precedence when both are supplied. Resolve the effective
    // label here and pass `text: undefined` so buildAnnotationFields does not
    // simultaneously write the inline arrow body label field alongside the
    // midpoint text node created below.
    const arrowSpec =
      spec.type === 'arrow'
        ? {
            ...primitiveSpec,
            text: undefined,
            label: spec.label ?? (Array.isArray(spec.text) ? spec.text.join('\n') : spec.text),
          }
        : primitiveSpec
    const { elementId, snappedStart, snappedEnd } = appendSingleAnnotation(doc, arrowSpec)
    // When arrow.label is set, add a separate midpoint label text element.
    if (spec.type === 'arrow' && arrowSpec.label && snappedEnd) {
      // Avoid label collisions by increasing offset, flipping side, then trying
      // near-end positions. Exclude the arrow itself and tombstones.
      const currentElements = doc.getMovableList('elements').toJSON() as Array<ExcalidrawElement>
      const obstacles = currentElements
        .filter((el) => el.isDeleted !== true)
        .filter((el) => el.id !== elementId)
        .filter(
          (el) =>
            el.type === 'rectangle' ||
            el.type === 'text' ||
            el.type === 'ellipse' ||
            el.type === 'diamond',
        )
        .map((el) => ({ x: el.x, y: el.y, width: el.width, height: el.height }))
      const labelPos = resolveArrowLabelPosition({
        start: snappedStart,
        end: snappedEnd,
        text: arrowSpec.label,
        offset: spec.labelOffset,
        side: spec.labelSide,
        obstacles,
      })
      const { elementId: labelId } = appendSingleAnnotation(doc, {
        type: 'text',
        coords: 'absolute',
        target: labelPos.target,
        text: labelPos.text,
        width: labelPos.width,
        height: labelPos.height,
        color: spec.color,
        // Mark midpoint label text so later arrow routing ignores it as an obstacle.
        isArrowLabel: true,
        fontFamily: spec.fontFamily,
        sessionPalette: spec.sessionPalette,
      })
      return { type: 'arrow', arrowId: elementId, labelId }
    }
    if (spec.type === 'arrow') {
      return { type: 'arrow', arrowId: elementId }
    }
    return { type: spec.type, elementId }
  }

  // box_with_label requires width plus at least title or text. height is only
  // required when autoFit is explicitly disabled; when autoFit is on (the
  // default), the box grows to fit the text so height=0 is a valid minimum.
  const hasText =
    spec.text !== undefined &&
    (Array.isArray(spec.text) ? spec.text.length > 0 : spec.text.length > 0)
  const hasTitle =
    spec.title !== undefined &&
    (Array.isArray(spec.title) ? spec.title.length > 0 : spec.title.length > 0)
  const autoFitEnabled = spec.autoFit !== false
  if (
    (!hasText && !hasTitle) ||
    spec.width === undefined ||
    (spec.height === undefined && !autoFitEnabled)
  ) {
    throw new Error(
      autoFitEnabled
        ? 'box_with_label requires title or text, plus width'
        : 'box_with_label requires title or text, plus width and height',
    )
  }

  // Resolve relative/absolute coordinates first; decomposeBoxWithLabel expects absolute input.
  const elements = doc.getMovableList('elements').toJSON() as ExcalidrawElement[]
  const absoluteTarget = resolveAnnotationPosition(
    { coords: spec.coords, imageId: spec.imageId, target: spec.target },
    elements,
  )
  // Text-ink contrast guard: when the caller delegated the color choice
  // (semantic key / palette key / omitted — anything but an explicit hex)
  // and the box has a solid fill, an ink below WCAG's large-text 3:1 against
  // that fill is swapped for a readable one picked by the fill's luminance.
  // The rectangle stroke keeps the requested color: the outline borders the
  // canvas background, not the fill, and recoloring it would change the
  // box's semantic identity.
  const MIN_TEXT_FILL_CONTRAST = 3
  const effectiveFillStyle = spec.fillStyle ?? (spec.backgroundColor ? 'solid' : undefined)
  let readableTextInk: string | undefined
  if (
    spec.backgroundColor !== undefined &&
    effectiveFillStyle === 'solid' &&
    (spec.color === undefined || !isExplicitHexColor(spec.color))
  ) {
    const fill = resolvePaletteColor(spec.backgroundColor, spec.sessionPalette ?? {}).color
    const ink = spec.color
      ? resolvePaletteColor(spec.color, spec.sessionPalette ?? {}).color
      : DEFAULT_COLORS.text
    const ratio = contrastRatio(ink, fill)
    if (ratio !== null && ratio < MIN_TEXT_FILL_CONTRAST) {
      readableTextInk = readableInkForFill(fill) ?? undefined
    }
  }
  const textInkOverride = readableTextInk !== undefined ? { color: readableTextInk } : {}

  const [rectSpec, textSpec, , subTextSpec, titleSpec] = decomposeBoxWithLabel({
    target: absoluteTarget,
    width: spec.width,
    height: spec.height ?? 0,
    title: spec.title,
    text: spec.text,
    subText: spec.subText,
    subTextPosition: spec.subTextPosition,
    autoFit: spec.autoFit,
    color: spec.color,
    backgroundColor: spec.backgroundColor,
    fillStyle: spec.fillStyle,
    strokeWidth: spec.strokeWidth,
    templateInstanceId: spec.templateInstanceId,
    fontFamily: spec.fontFamily,
    align: spec.align,
  })
  // Append all decomposed specs as absolute coordinates.
  const { elementId: rectId } = appendSingleAnnotation(doc, {
    ...rectSpec,
    coords: 'absolute',
    sessionPalette: spec.sessionPalette,
  })
  const titleId = titleSpec
    ? appendSingleAnnotation(doc, {
        ...titleSpec,
        ...textInkOverride,
        coords: 'absolute',
        sessionPalette: spec.sessionPalette,
      }).elementId
    : undefined
  const textId = textSpec
    ? appendSingleAnnotation(doc, {
        ...textSpec,
        ...textInkOverride,
        coords: 'absolute',
        sessionPalette: spec.sessionPalette,
      }).elementId
    : undefined
  const subTextId = subTextSpec
    ? appendSingleAnnotation(doc, {
        ...subTextSpec,
        ...textInkOverride,
        coords: 'absolute',
        sessionPalette: spec.sessionPalette,
      }).elementId
    : undefined
  // inside-bottom splits the rectangle into main/sub zones. Skip containerId
  // binding because a rect can bind only one text element.
  const isInsideBottom = (spec.subTextPosition ?? 'inside-bottom') === 'inside-bottom'
  const list = doc.getMovableList('elements')
  for (let i = 0; i < list.length; i++) {
    const m = list.get(i)
    if (!(m instanceof LoroMap)) continue
    const id = m.get('id')
    if (isInsideBottom || titleId !== undefined) {
      if (id === titleId || id === textId || id === subTextId) {
        m.set('textAlign', spec.align ?? 'center')
      }
      continue
    }
    if (id === rectId) {
      if (textId) {
        m.set('boundElements', [{ id: textId, type: 'text' }])
      }
    } else if (id === textId) {
      m.set('containerId', rectId)
      m.set('textAlign', spec.align ?? 'center')
      m.set('verticalAlign', 'middle')
      // autoResize=true ignores width and uses rendered content width, which
      // breaks containerId binding.
      m.set('autoResize', false)
    }
  }
  return {
    type: 'box_with_label',
    rectId,
    ...(titleId ? { titleId } : {}),
    ...(textId ? { textId } : {}),
    ...(subTextId ? { subTextId } : {}),
  }
}

// Fetch a Loro snapshot from the server.
export async function apiGetSnapshot(
  client: DaemonClient,
  workspaceId: string,
  slug: string,
): Promise<LoroDoc> {
  const res = await client.request(
    `/api/canvas/${workspaceId}/${encodeURIComponent(slug)}/snapshot`,
  )
  if (!res.ok) throw new Error(`GET /snapshot failed: ${res.status}`)
  const bytes = new Uint8Array(await res.arrayBuffer())
  return LoroDoc.fromSnapshot(bytes)
}

// Send a binary Loro update to the server.
export async function apiPostLoroUpdate(
  client: DaemonClient,
  workspaceId: string,
  slug: string,
  update: Uint8Array,
): Promise<void> {
  const res = await client.request(
    `/api/canvas/${workspaceId}/${encodeURIComponent(slug)}/update`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: update,
    },
  )
  if (!res.ok) throw new Error(`POST /update failed: ${res.status}`)
}

export function annotateTool() {
  return {
    name: 'annotate',
    description:
      'Add annotation (arrow, text, rectangle, highlight, box_with_label) to the whiteboard canvas. box_with_label is a composite of rectangle + centered text label (requires text/title and width; height is optional and defaults to auto-fit). IMPORTANT: box_with_label does NOT auto-wrap long text; the caller must pre-split long lines by passing text as string[] (each element = 1 line) so the label fits within width.',
    // Derived from the Zod shape so the JSON-Schema view can never drift from
    // what registerToolWithAnnotations actually validates against.
    inputSchema: z.toJSONSchema(z.object(annotateInputShape)) as {
      type: 'object'
      properties: Record<string, unknown>
      required?: string[]
    },
    execute: async (
      args: z.infer<typeof annotateInputSchema>,
      client: DaemonClient,
    ): Promise<z.infer<typeof annotateOutputSchema>> => {
      // registerToolWithAnnotations only hands the MCP SDK annotateInputShape
      // (a ZodRawShape, which cannot express cross-field constraints), so the
      // "target required unless startBoxId/group" check runs here instead.
      const validation = annotateInputSchema.safeParse(args)
      if (!validation.success) {
        throw new Error(validation.error.issues[0]?.message ?? 'Invalid annotate arguments')
      }
      const { workspaceId, slug } = parseCanvasId(args.canvasId)
      await assertCanvasExists(client, workspaceId, slug)
      const sessionPalette = await apiGetPalette(client, workspaceId)
      const unknownPaletteKeySet = new Set<string>()
      for (const colorArg of [args.color, args.backgroundColor]) {
        if (colorArg) {
          const { warningKey } = resolvePaletteColor(colorArg, sessionPalette)
          if (warningKey) unknownPaletteKeySet.add(warningKey)
        }
      }
      const unknownPaletteKeys = Array.from(unknownPaletteKeySet)
      const warnings: z.infer<typeof annotateWarningSchema>[] = []
      if (
        args.type === 'box_with_label' &&
        (args.text !== undefined || args.title !== undefined) &&
        args.width !== undefined &&
        (args.height !== undefined || args.autoFit !== false)
      ) {
        const [, , diag] = decomposeBoxWithLabel({
          target: args.target ?? { x: 0, y: 0 },
          width: args.width,
          height: args.height ?? 0,
          title: args.title,
          text: args.text,
          subText: args.subText,
          subTextPosition: args.subTextPosition,
          autoFit: args.autoFit,
          color: args.color,
        })
        if (diag.overflow) warnings.push(diag)
      }
      // Known limitation: if another client moves/resizes the image between
      // snapshot fetch and update post, the annotation can drift.
      const doc = await apiGetSnapshot(client, workspaceId, slug)
      const prevVV = doc.version()
      // group ignores target, so default to the origin when it is omitted.
      const spec: AnnotationSpec = {
        ...args,
        target: args.target ?? { x: 0, y: 0 },
        sessionPalette,
      }
      const annotation = appendAnnotationToDoc(doc, spec)
      const elementIds = flattenAnnotationResult(annotation)
      doc.commit()
      await apiPostLoroUpdate(
        client,
        workspaceId,
        slug,
        doc.export({ mode: 'update', from: prevVV }),
      )
      // Preserve the legacy elementId/elementIds contract and add the structured
      // annotation result for callers that need internal composite ids.
      const unknownKeys = unknownPaletteKeys.length > 0 ? { unknownPaletteKeys } : {}
      return elementIds.length === 1
        ? { elementId: elementIds[0], annotation, warnings, ...unknownKeys }
        : { elementIds, annotation, warnings, ...unknownKeys }
    },
  }
}
