// Pure helper that assembles the full field map for an Excalidraw element.
// LoroMap.set side effects stay with the caller (annotate.ts). now / seed /
// versionNonce are injected so tests stay deterministic.
//
// Omitting required fields can make Excalidraw's updateScene throw and blank
// the whole canvas, so even "unused" validator-visible fields must be set.

import { estimateTextWidth } from './estimate-text-width.js'
import { wrapTextToWidth } from './wrap-text-to-width.js'

export type AnnotationType = 'arrow' | 'text' | 'rectangle' | 'highlight'

export interface BuildAnnotationFieldsInput {
  elementId: string
  type: AnnotationType
  x: number
  y: number
  strokeColor: string
  now: number
  seed: number
  versionNonce: number
  text?: string
  width?: number
  height?: number
  // text only: resolved horizontal alignment. Defaults to 'left'.
  textAlign?: 'left' | 'center' | 'right'
  // text only: Excalidraw fontFamily. Current default is Excalifont (5).
  fontFamily?: 1 | 2 | 3 | 5 | 6 | 7 | 8 | 9
  fontSize?: number
  preserveLineBreaks?: boolean
  // arrow only: absolute end target. When present, points become [[0,0],[dx,dy]].
  endTarget?: { x: number; y: number }
  // arrow only: relative route points from start=[0,0]. Takes precedence over
  // endTarget and is used for orthogonal L/Z routes.
  points?: [number, number][]
  // Visual style overrides. Defaults stay type-specific when omitted.
  backgroundColor?: string
  fillStyle?: 'solid' | 'hachure' | 'cross-hatch'
  strokeWidth?: number
  // Shared ID used by template_insert so all elements from one insert can be
  // targeted together later. export_canvas({format:'json'}) strips it by default.
  templateInstanceId?: string
  // Marks text created as an arrow midpoint label so routing can ignore it as
  // an obstacle.
  isArrowLabel?: boolean
}

export type AnnotationFields = Record<string, unknown>

export function buildAnnotationFields(input: BuildAnnotationFieldsInput): AnnotationFields {
  const common: AnnotationFields = {
    id: input.elementId,
    x: input.x,
    y: input.y,
    angle: 0,
    strokeColor: input.strokeColor,
    strokeWidth: input.strokeWidth ?? 2,
    strokeStyle: 'solid',
    // Leave templateInstanceId undefined when absent so the caller can omit it.
    ...(input.templateInstanceId !== undefined
      ? { templateInstanceId: input.templateInstanceId }
      : {}),
    // Arrow-label marker. Only meaningful on text, but harmless elsewhere.
    ...(input.isArrowLabel ? { isArrowLabel: true } : {}),
    roughness: 0,
    roundness: null,
    groupIds: [],
    boundElements: null,
    frameId: null,
    link: null,
    locked: false,
    isDeleted: false,
    updated: input.now,
    seed: input.seed,
    versionNonce: input.versionNonce,
    version: 1,
  }

  if (input.type === 'arrow') {
    // Prefer explicit route points, then derive a 2-point segment from endTarget,
    // then fall back to a 100px horizontal arrow.
    const points: [number, number][] =
      input.points ??
      (input.endTarget
        ? [
            [0, 0],
            [input.endTarget.x - input.x, input.endTarget.y - input.y],
          ]
        : [
            [0, 0],
            [100, 0],
          ])
    // Compute the bbox from all points so intermediate elbows are covered.
    const xs = points.map((p) => p[0])
    const ys = points.map((p) => p[1])
    const bboxW = Math.max(...xs) - Math.min(...xs)
    const bboxH = Math.max(...ys) - Math.min(...ys)
    const fields: AnnotationFields = {
      ...common,
      type: 'arrow',
      width: bboxW,
      height: bboxH,
      opacity: 100,
      backgroundColor: 'transparent',
      fillStyle: 'solid',
      points,
      startArrowhead: null,
      endArrowhead: 'arrow',
      startBinding: null,
      endBinding: null,
    }
    if (input.text !== undefined) {
      fields.label = { text: input.text }
    }
    return fields
  }

  if (input.type === 'text') {
    // Estimate text width/height from content so multiline/long text does not
    // clip when width/height are omitted. Explicit dimensions still win.
    const resolvedFontSize = input.fontSize ?? 20
    const baseRaw = input.text ?? ''
    const wrappedLines =
      input.width !== undefined && input.preserveLineBreaks !== true && !baseRaw.includes('\n')
        ? wrapTextToWidth(baseRaw, input.width, resolvedFontSize)
        : undefined
    const raw = wrappedLines ? wrappedLines.join('\n') : baseRaw
    const lines = raw.length === 0 ? [''] : raw.split('\n')
    const estW = lines.reduce(
      (max, line) => Math.max(max, estimateTextWidth(line, resolvedFontSize)),
      0,
    )
    const autoWidth = Math.max(estW + 10, 20)
    const autoHeight = Math.ceil(lines.length * resolvedFontSize * 1.3)
    return {
      ...common,
      type: 'text',
      width: input.width ?? autoWidth,
      height: input.height ?? autoHeight,
      opacity: 100,
      backgroundColor: 'transparent',
      fillStyle: 'solid',
      strokeWidth: 1,
      text: raw,
      originalText: raw,
      fontSize: resolvedFontSize,
      fontFamily: input.fontFamily ?? 5,
      textAlign: input.textAlign ?? 'left',
      verticalAlign: 'top',
      baseline: Math.max(12, Math.round(resolvedFontSize * 0.9)),
      containerId: null,
      lineHeight: 1.2,
    }
  }

  const isHighlight = input.type === 'highlight'
  const defaultBgColor = isHighlight ? input.strokeColor : 'transparent'
  const defaultFillStyle = isHighlight ? 'solid' : 'hachure'
  return {
    ...common,
    type: 'rectangle',
    width: input.width ?? 120,
    height: input.height ?? 80,
    opacity: isHighlight ? 30 : 100,
    backgroundColor: input.backgroundColor ?? defaultBgColor,
    fillStyle: input.fillStyle ?? defaultFillStyle,
  }
}
