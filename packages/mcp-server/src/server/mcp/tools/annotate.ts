import { LoroDoc, LoroMap } from 'loro-crdt'
import { nanoid } from 'nanoid'
import type { DaemonClient } from '../daemon-client.js'
import {
  type AnnotationFields,
  type AnnotationType,
  buildAnnotationFields,
} from './annotation-fields.js'
import { decomposeBoxWithLabel, type SubTextPosition } from './box-with-label.js'
import { parseCanvasId } from './canvas-id.js'
import { decomposeGroup } from './group.js'
import { resolvePaletteColor } from './color-palette.js'
import { apiGetPalette } from './palette.js'
import { resolveAnnotationPosition, type CoordsMode } from './resolve-annotation-position.js'
import { resolveArrowLabelPosition } from './resolve-arrow-label-position.js'
import { resolveArrowRoute } from './resolve-arrow-route.js'
import { resolveTextPosition, type TextAlign } from './resolve-text-position.js'
import { snapArrowEndpoints, type Rect } from './snap-arrow.js'

// box_with_label and group are composite types accepted only by the public
// annotate API. Internally they are decomposed into primitive elements.
export type AnnotatePublicType = AnnotationType | 'box_with_label' | 'group'

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
    const container = elements.find((candidate) => candidate.id === el.containerId && !candidate.isDeleted)
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
): { elementId: string; snappedStart: { x: number; y: number }; snappedEnd?: { x: number; y: number } } {
  const elements = doc.getMovableList('elements').toJSON() as ExcalidrawElement[]
  const resolved = resolveAnnotationPosition(
    { coords: spec.coords, imageId: spec.imageId, target: spec.target },
    elements,
  )
  const { x: anchorX, y: anchorY } = resolved
  // Only text resolves anchor semantics. Other types keep target as top-left.
  const textAnchor =
    spec.type === 'text'
      ? resolveTextPosition({ target: { x: anchorX, y: anchorY }, width: spec.width, align: spec.align })
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
    const { elementId, snappedStart, snappedEnd } = appendSingleAnnotation(
      doc,
      spec as AnnotationSpec & { type: AnnotationType },
    )
    // When arrow.label is set, add a separate midpoint label text element.
    if (spec.type === 'arrow' && spec.label && snappedEnd) {
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
        text: spec.label,
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

  // box_with_label requires width/height plus at least title or text.
  const hasText =
    spec.text !== undefined &&
    (Array.isArray(spec.text) ? spec.text.length > 0 : spec.text.length > 0)
  const hasTitle =
    spec.title !== undefined &&
    (Array.isArray(spec.title) ? spec.title.length > 0 : spec.title.length > 0)
  if ((!hasText && !hasTitle) || spec.width === undefined || spec.height === undefined) {
    throw new Error('box_with_label requires title or text, plus width and height')
  }

  // Resolve relative/absolute coordinates first; decomposeBoxWithLabel expects absolute input.
  const elements = doc.getMovableList('elements').toJSON() as ExcalidrawElement[]
  const absoluteTarget = resolveAnnotationPosition(
    { coords: spec.coords, imageId: spec.imageId, target: spec.target },
    elements,
  )
  const [rectSpec, textSpec, , subTextSpec, titleSpec] = decomposeBoxWithLabel({
    target: absoluteTarget,
    width: spec.width,
    height: spec.height,
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
        coords: 'absolute',
        sessionPalette: spec.sessionPalette,
      }).elementId
    : undefined
  const textId = textSpec
    ? appendSingleAnnotation(doc, {
        ...textSpec,
        coords: 'absolute',
        sessionPalette: spec.sessionPalette,
      }).elementId
    : undefined
  const subTextId = subTextSpec
    ? appendSingleAnnotation(doc, {
        ...subTextSpec,
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
  sessionId: string,
  slug: string,
): Promise<LoroDoc> {
  const res = await client.request(
    `/api/canvas/${sessionId}/${encodeURIComponent(slug)}/snapshot`,
  )
  if (!res.ok) throw new Error(`GET /snapshot failed: ${res.status}`)
  const bytes = new Uint8Array(await res.arrayBuffer())
  return LoroDoc.fromSnapshot(bytes)
}

// Send a binary Loro update to the server.
export async function apiPostLoroUpdate(
  client: DaemonClient,
  sessionId: string,
  slug: string,
  update: Uint8Array,
): Promise<void> {
  const res = await client.request(`/api/canvas/${sessionId}/${encodeURIComponent(slug)}/update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: update,
  })
  if (!res.ok) throw new Error(`POST /update failed: ${res.status}`)
}

export function annotateTool() {
  return {
    name: 'annotate',
    description:
      'Add annotation (arrow, text, rectangle, highlight, box_with_label) to the whiteboard canvas. box_with_label is a composite of rectangle + centered text label (requires text, width, height). IMPORTANT: box_with_label does NOT auto-wrap long text; the caller must pre-split long lines by passing text as string[] (each element = 1 line) so the label fits within width.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        canvasId: { type: 'string', description: 'Canvas ID (workspaceId/slug)' },
        type: {
          type: 'string',
          enum: ['arrow', 'text', 'rectangle', 'highlight', 'box_with_label', 'group'],
          description:
            'Annotation type. "box_with_label" creates a rectangle with a centered text label in one call (text/width/height required). "group" draws a bounding rectangle around existing elements specified by memberIds, with optional title above.',
        },
        imageId: {
          type: 'string',
          description: 'Element ID of the reference image (optional, only used when coords="relative")',
        },
        coords: {
          type: 'string',
          enum: ['absolute', 'relative', 'parent'],
          description:
            'Coordinate mode for target. "absolute": target.x/y are canvas pixels (use this with canvas_inspect output). "relative": target.x/y are 0.0-1.0 relative to a reference image (requires imageId or an existing image). "parent": same as "relative" but the annotation tracks the parent image — if the image is later moved/resized, the annotation follows (stale-snapshot safe). If omitted, autodetects: uses relative when an image exists, otherwise absolute.',
        },
        target: {
          type: 'object',
          description:
            'Position of the annotation. Interpreted per coords: "absolute" = canvas px, "relative" = 0.0-1.0 within the reference image.',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
          },
          required: ['x', 'y'],
        },
        text: {
          description:
            'Text content. string for single line, string[] for multi-line (joined with "\\n"). box_with_label centers multi-line vertically and does NOT auto-wrap — pre-split long text into string[] to fit within width.',
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' } },
          ],
        },
        title: {
          description:
            'box_with_label/group only: title text. box_with_label places it above the body inside the rectangle; group places it above the bounding rect.',
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
            'Fill color for rectangle / box_with_label / highlight / arrow. Hex (#rrggbb) or semantic key. Default: rectangle/box=transparent, highlight=strokeColor. Use with fillStyle=solid for a filled box.',
        },
        fillStyle: {
          type: 'string',
          enum: ['solid', 'hachure', 'cross-hatch'],
          description:
            'Fill pattern for rectangle / box_with_label / highlight. Default: rectangle/box=hachure, highlight=solid.',
        },
        strokeWidth: {
          type: 'number',
          description:
            'Stroke line width. Default 2. Useful on arrow to emphasize flow at large canvases.',
        },
        fontFamily: {
          type: 'number',
          enum: [1, 2, 3, 5, 6, 7, 8, 9],
          description:
            'Text font family. Current: 5 = Excalifont (hand-drawn, default), 6 = Nunito (sans), 7 = "Lilita One" (display), 8 = "Comic Shanns" (monospace, for paths / identifiers / code), 9 = "Liberation Sans". Legacy: 1 = Virgil, 2 = Helvetica, 3 = Cascadia (UI marks these as "old"). Applies to text / box_with_label main text + subText / arrow label.',
        },
        fontSize: {
          type: 'number',
          description:
            'text only: explicit font size in px. Without this field, text defaults to 20px.',
        },
        width: { type: 'number', description: 'Override width (rectangle/highlight/text; for arrow, use endTarget instead)' },
        height: { type: 'number', description: 'Override height (rectangle/highlight/text; for arrow, use endTarget instead)' },
        align: {
          type: 'string',
          enum: ['left', 'center', 'right'],
          description:
            'text / box_with_label: horizontal alignment. box_with_label applies the same alignment to title/body/subText.',
        },
        endTarget: {
          type: 'object',
          description: 'Arrow endpoint. Interpreted per coords (absolute px or relative 0-1 within reference image). target is start, endTarget is end.',
          properties: { x: { type: 'number' }, y: { type: 'number' } },
          required: ['x', 'y'],
        },
        startBoxId: {
          type: 'string',
          description:
            'arrow only: element id whose rectangle acts as the snap anchor for the start point. The start is projected onto the box edge along the line toward the end. Unknown/deleted ids are ignored. Pass box/image center as target.',
        },
        endBoxId: {
          type: 'string',
          description:
            'arrow only: element id whose rectangle acts as the snap anchor for the end point. The end is projected onto the box edge along the line toward the start. Unknown/deleted ids are ignored. Pass box/image center as endTarget.',
        },
        label: {
          type: 'string',
          description:
            'arrow only: label text placed at the midpoint of the (snap-applied) arrow. Creates an additional text element above the line. Use for edge labels in diagrams.',
        },
        labelOffset: {
          type: 'number',
          description:
            'arrow.label only: perpendicular distance from the line to the label center (default 6).',
        },
        labelSide: {
          type: 'string',
          enum: ['auto', 'above', 'below', 'left', 'right'],
          description:
            'arrow.label only: which side of the line to place the label. "auto" (default) selects the upper side. Geometrically indeterminate combinations (horizontal + left/right, vertical + above/below) fall back to auto.',
        },
        memberIds: {
          type: 'array',
          items: { type: 'string' },
          description:
            'group only: element ids to enclose. The bounding rect is computed from existing non-deleted members (unknown/deleted ids are ignored).',
        },
        padding: {
          type: 'number',
          description: 'group only: padding (px) added around the bbox (default 20).',
        },
      },
      required: ['canvasId', 'type'],
    },
    execute: async (
      args: {
        canvasId: string
        type: AnnotatePublicType
        imageId?: string
        coords?: CoordsMode
        target?: { x: number; y: number }
        text?: string | string[]
        title?: string | string[]
        subText?: string | string[]
        subTextPosition?: SubTextPosition
        autoFit?: boolean
        color?: string
        backgroundColor?: string
        fillStyle?: 'solid' | 'hachure' | 'cross-hatch'
        strokeWidth?: number
        width?: number
        height?: number
        align?: TextAlign
        endTarget?: { x: number; y: number }
        startBoxId?: string
        endBoxId?: string
        label?: string
        labelOffset?: number
        labelSide?: 'auto' | 'above' | 'below' | 'left' | 'right'
        memberIds?: string[]
        padding?: number
        fontFamily?: 1 | 2 | 3 | 5 | 6 | 7 | 8 | 9
        fontSize?: number
      },
      client: DaemonClient,
    ) => {
      const { sessionId, slug } = parseCanvasId(args.canvasId)
      const sessionPalette = await apiGetPalette(client, sessionId)
      // Return box_with_label overflow diagnostics in the same shape as
      // annotate_batch. This can be computed before fetching the snapshot.
      const warnings: { overflow: boolean; requiredWidth: number; requiredHeight: number }[] = []
      if (
        args.type === 'box_with_label' &&
        (args.text !== undefined || args.title !== undefined) &&
        args.width !== undefined &&
        args.height !== undefined
      ) {
        const [, , diag] = decomposeBoxWithLabel({
          target: args.target ?? { x: 0, y: 0 },
          width: args.width,
          height: args.height,
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
      const doc = await apiGetSnapshot(client, sessionId, slug)
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
      await apiPostLoroUpdate(client, sessionId, slug, doc.export({ mode: 'update', from: prevVV }))
      // Preserve the legacy elementId/elementIds contract and add the structured
      // annotation result for callers that need internal composite ids.
      return elementIds.length === 1
        ? { elementId: elementIds[0], annotation, warnings }
        : { elementIds, annotation, warnings }
    },
  }
}
