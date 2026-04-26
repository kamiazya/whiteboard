// Pure helper that decomposes a box_with_label composite annotation into
// primitive specs. Coordinate resolution happens upstream, so this function
// only receives absolute positions. The text bbox initially matches the rect;
// Excalidraw handles bound-text wrapping, padding, and centering.

import { estimateTextWidth } from './estimate-text-width.js'
import { wrapTextToWidth } from './wrap-text-to-width.js'

// Inner padding for Excalidraw bound text (5px on each side).
const BOUND_TEXT_PADDING = 5
// Default font size and line-height ratio.
const DEFAULT_FONT_SIZE = 20
const LINE_HEIGHT_RATIO = 1.25
// Render subText in a slightly smaller font.
const SUBTEXT_FONT_SIZE = 14
const TITLE_FONT_SIZE = 28
// Vertical gap between the main rect and subText.
const SUBTEXT_GAP = 6
const TITLE_GAP = 6
const BODY_GAP = 6

// subText placement mode.
export type SubTextPosition = 'top' | 'inside-bottom'

export interface BoxWithLabelInput {
  target: { x: number; y: number }
  width: number
  height: number
  title?: string | string[]
  // Use string for one line and string[] for multiple lines.
  text?: string | string[]
  // Supplemental 14px text rendered as a separate text element.
  subText?: string | string[]
  // subText placement. Default: inside-bottom.
  subTextPosition?: SubTextPosition
  // Auto-expand height when overflow is detected.
  autoFit?: boolean
  color?: string
  // Visual style overrides applied to the rectangle.
  backgroundColor?: string
  fillStyle?: 'solid' | 'hachure' | 'cross-hatch'
  strokeWidth?: number
  // Shared template instance id propagated to all generated child elements.
  templateInstanceId?: string
  // Excalidraw fontFamily. The same value is propagated to main text and subText.
  fontFamily?: 1 | 2 | 3 | 5 | 6 | 7 | 8 | 9
  align?: 'left' | 'center' | 'right'
}

export interface RectSpec {
  type: 'rectangle'
  target: { x: number; y: number }
  width: number
  height: number
  color?: string
  backgroundColor?: string
  fillStyle?: 'solid' | 'hachure' | 'cross-hatch'
  strokeWidth?: number
  templateInstanceId?: string
}

export interface TextSpec {
  type: 'text'
  target: { x: number; y: number }
  text: string
  width: number
  height: number
  color?: string
  templateInstanceId?: string
  fontFamily?: 1 | 2 | 3 | 5 | 6 | 7 | 8 | 9
  fontSize?: number
  align?: 'left' | 'center' | 'right'
}

// Comparison between estimated text size and the box's usable space. annotate_batch
// turns these diagnostics into warnings.
export interface Diagnostics {
  overflow: boolean
  requiredWidth: number
  requiredHeight: number
  // Difference added beyond input.height when autoFit expands the box.
  autoExpandedBy: number
  // Actual rectangle height after decomposition.
  actualHeight: number
}

function normalizeLines(
  text: string | string[] | undefined,
  usableWidth: number,
  fontSize: number,
  autoFit: boolean | undefined,
): string[] {
  if (text === undefined) return []
  if (Array.isArray(text)) {
    return autoFit !== false
      ? text.flatMap((line) => wrapTextToWidth(line, usableWidth, fontSize))
      : text
  }
  return wrapTextToWidth(text, usableWidth, fontSize)
}

function linesHeight(lines: string[], fontSize: number): number {
  return lines.length * fontSize * LINE_HEIGHT_RATIO
}

export function decomposeBoxWithLabel(
  input: BoxWithLabelInput,
): [RectSpec, TextSpec | undefined, Diagnostics, TextSpec?, TextSpec?] {
  // Wrap against the box's inner width. string input always wraps; string[]
  // respects caller-provided lines only when autoFit is explicitly false.
  const usableWidthForWrap = Math.max(0, input.width - 2 * BOUND_TEXT_PADDING)
  const titleLines = normalizeLines(input.title, usableWidthForWrap, TITLE_FONT_SIZE, input.autoFit)
  const lines = normalizeLines(input.text, usableWidthForWrap, DEFAULT_FONT_SIZE, input.autoFit)

  // Maximum estimated line width becomes the required width.
  const requiredWidth = Math.max(
    0,
    ...titleLines.map((line) => estimateTextWidth(line, TITLE_FONT_SIZE)),
    ...lines.map((line) => estimateTextWidth(line, DEFAULT_FONT_SIZE)),
  )
  const titleHeight = linesHeight(titleLines, TITLE_FONT_SIZE)
  const bodyHeight = linesHeight(lines, DEFAULT_FONT_SIZE)
  const titleToBodyGap = titleLines.length > 0 && lines.length > 0 ? TITLE_GAP : 0
  const requiredHeight = titleHeight + titleToBodyGap + bodyHeight

  // subText height, when present.
  const subLines = input.subText === undefined
    ? []
    : Array.isArray(input.subText) ? input.subText : [input.subText]
  const subHeight = subLines.length * SUBTEXT_FONT_SIZE * LINE_HEIGHT_RATIO
  const position: SubTextPosition = input.subTextPosition ?? 'inside-bottom'

  // autoFit is enabled by default. Expand effectiveHeight to absorb overflow;
  // wrapping already handles width.
  const paddingDelta = 2 * BOUND_TEXT_PADDING
  const neededMainHeight = requiredHeight + paddingDelta
  const neededTotalHeight = position === 'inside-bottom' && subLines.length > 0
    ? neededMainHeight + subHeight + BODY_GAP
    : neededMainHeight
  const effectiveHeight = input.autoFit !== false
    ? Math.max(input.height, neededTotalHeight)
    : input.height

  // Excalidraw's default fill is "hachure" (diagonal lines on a transparent
  // base). That looks great on the empty-canvas aesthetic, but once a caller
  // sets `backgroundColor` they almost always want the body to be readable —
  // hachure leaves big white gaps that swallow light-on-color labels (the
  // dogfood found this with `color: '#ffffff'` on a palette-tinted bg).
  // Default to solid when a background is explicitly themed; preserve any
  // explicit caller override.
  const rect: RectSpec = {
    type: 'rectangle',
    target: input.target,
    width: input.width,
    height: effectiveHeight,
    color: input.color,
    backgroundColor: input.backgroundColor,
    fillStyle: input.fillStyle ?? (input.backgroundColor ? 'solid' : undefined),
    strokeWidth: input.strokeWidth,
    templateInstanceId: input.templateInstanceId,
  }

  // Evaluate overflow against effectiveHeight, so autoFit can clear it.
  const usableWidth = input.width - 2 * BOUND_TEXT_PADDING
  const mainUsableHeight = position === 'inside-bottom' && subLines.length > 0
    ? Math.max(0, effectiveHeight - paddingDelta - subHeight - BODY_GAP)
    : effectiveHeight - paddingDelta
  const overflow = requiredWidth > usableWidth || requiredHeight > mainUsableHeight
  // Height delta beyond the caller-provided input.height.
  const autoExpandedBy = Math.max(0, effectiveHeight - input.height)
  const actualHeight = effectiveHeight

  const boundLegacyBody = titleLines.length === 0 && position !== 'inside-bottom'

  if (input.subText === undefined && titleLines.length === 0) {
    const text: TextSpec = {
      type: 'text',
      target: input.target,
      text: lines.join('\n'),
      width: input.width,
      height: effectiveHeight,
      color: input.color,
      ...(input.templateInstanceId !== undefined
        ? { templateInstanceId: input.templateInstanceId }
        : {}),
      ...(input.fontFamily !== undefined ? { fontFamily: input.fontFamily } : {}),
    }
    return [rect, text, { overflow, requiredWidth, requiredHeight, autoExpandedBy, actualHeight }]
  }

  const titleSpec = titleLines.length === 0
    ? undefined
    : {
        type: 'text' as const,
        target: {
          x: input.target.x,
          y: input.target.y,
        },
        text: titleLines.join('\n'),
        width: input.width,
        height: titleHeight,
        color: input.color,
        ...(input.templateInstanceId !== undefined
          ? { templateInstanceId: input.templateInstanceId }
          : {}),
        ...(input.fontFamily !== undefined ? { fontFamily: input.fontFamily } : {}),
        fontSize: TITLE_FONT_SIZE,
      }

  if (position === 'inside-bottom') {
    // Split the rect into main and sub zones. containerId binding is skipped, so
    // main.height becomes the height of the upper zone.
    const mainZoneHeight = Math.max(0, effectiveHeight - paddingDelta - subHeight - BODY_GAP)
    const bodyY = input.target.y + titleHeight + titleToBodyGap
    const bodyZoneHeight = titleLines.length > 0
      ? Math.max(0, mainZoneHeight - titleHeight - titleToBodyGap)
      : mainZoneHeight
    const text = lines.length === 0
      ? undefined
      : {
          type: 'text' as const,
          target: { x: input.target.x, y: bodyY },
          text: lines.join('\n'),
          width: input.width,
          height: bodyZoneHeight,
          color: input.color,
          ...(input.templateInstanceId !== undefined
            ? { templateInstanceId: input.templateInstanceId }
            : {}),
          ...(input.fontFamily !== undefined ? { fontFamily: input.fontFamily } : {}),
        }
    const subText: TextSpec = {
      type: 'text',
      target: {
        x: input.target.x,
        y: input.target.y + effectiveHeight - subHeight,
      },
      text: subLines.join('\n'),
      width: input.width,
      height: subHeight,
      color: input.color,
      ...(input.templateInstanceId !== undefined
        ? { templateInstanceId: input.templateInstanceId }
        : {}),
      ...(input.fontFamily !== undefined ? { fontFamily: input.fontFamily } : {}),
      fontSize: SUBTEXT_FONT_SIZE,
    }
    return [rect, text, { overflow, requiredWidth, requiredHeight, autoExpandedBy, actualHeight }, subText, titleSpec]
  }

  // Default "top" mode: render an independent text element above the rect with
  // matching left edge and width, without containerId binding.
  const bodyTargetY = boundLegacyBody
    ? input.target.y
    : input.target.y + titleHeight + titleToBodyGap
  const bodyHeightForTop = boundLegacyBody
    ? effectiveHeight
    : Math.max(0, effectiveHeight - paddingDelta - titleHeight - titleToBodyGap)
  const text = lines.length === 0
    ? undefined
      : {
        type: 'text' as const,
        target: boundLegacyBody ? input.target : { x: input.target.x, y: bodyTargetY },
        text: lines.join('\n'),
        width: input.width,
        height: bodyHeightForTop,
        color: input.color,
        ...(input.fontFamily !== undefined ? { fontFamily: input.fontFamily } : {}),
      }
  const subText: TextSpec = {
    type: 'text',
    target: { x: input.target.x, y: input.target.y - subHeight - SUBTEXT_GAP },
    text: subLines.join('\n'),
    width: input.width,
    height: subHeight,
    color: input.color,
    ...(input.fontFamily !== undefined ? { fontFamily: input.fontFamily } : {}),
    fontSize: SUBTEXT_FONT_SIZE,
  }

  return [rect, text, { overflow, requiredWidth, requiredHeight, autoExpandedBy, actualHeight }, subText, titleSpec]
}
