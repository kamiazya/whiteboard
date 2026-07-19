// Pure helper that places arrow label text near the midpoint. Labels are
// offset along the normal so they do not sit on the line. For diagonals, the
// default side is the visually upper direction. When obstacles are supplied,
// it tries larger offsets, the opposite side, and then near-end positions.

import { estimateTextWidth } from './estimate-text-width.js'

type ArrowLabelSide = 'auto' | 'above' | 'below' | 'left' | 'right'

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface ResolveArrowLabelPositionInput {
  start: { x: number; y: number }
  end: { x: number; y: number }
  text: string
  offset?: number
  // Label placement side. Ambiguous combinations fall back to auto.
  side?: ArrowLabelSide
  // Obstacles to avoid. Callers should already exclude deleted elements and
  // the arrow itself.
  obstacles?: Rect[]
}

export interface ResolveArrowLabelPositionResult {
  target: { x: number; y: number }
  width: number
  height: number
  text: string
}

const LABEL_HEIGHT = 24

// Check overlap between axis-aligned rectangles. Edge-touching does not count.
function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}

interface NormalVector {
  nx: number
  ny: number
}

// Compute the normal vector for the chosen side. Zero-length arrows return 0.
function computeNormal(
  dx: number,
  dy: number,
  length: number,
  side: ArrowLabelSide,
  flip: boolean,
): NormalVector {
  if (length === 0) return { nx: 0, ny: 0 }
  const rawNx = -dy / length
  const rawNy = dx / length
  let useNegate: boolean
  switch (side) {
    case 'above':
      useNegate = rawNy > 0
      break
    case 'below':
      useNegate = rawNy < 0
      break
    case 'left':
      useNegate = rawNx === 0 ? rawNy > 0 : rawNx > 0
      break
    case 'right':
      useNegate = rawNx === 0 ? rawNy > 0 : rawNx < 0
      break
    default:
      useNegate = rawNy > 0
      break
  }
  // Flip the chosen side when requested.
  if (flip) useNegate = !useNegate
  const sign = useNegate ? -1 : 1
  return { nx: rawNx * sign, ny: rawNy * sign }
}

// Build one candidate placement. t is the along-line position.
function buildCandidate(
  input: ResolveArrowLabelPositionInput,
  width: number,
  offset: number,
  flip: boolean,
  t: number,
): ResolveArrowLabelPositionResult & { rect: Rect } {
  const dx = input.end.x - input.start.x
  const dy = input.end.y - input.start.y
  const length = Math.hypot(dx, dy)
  const side: ArrowLabelSide = input.side ?? 'auto'
  const { nx, ny } = computeNormal(dx, dy, length, side, flip)
  const baseX = input.start.x + dx * t
  const baseY = input.start.y + dy * t
  const centerX = baseX + nx * offset
  const centerY = baseY + ny * offset
  const target = {
    x: centerX - width / 2,
    y: centerY - LABEL_HEIGHT / 2,
  }
  return {
    target,
    width,
    height: LABEL_HEIGHT,
    text: input.text,
    rect: { x: target.x, y: target.y, width, height: LABEL_HEIGHT },
  }
}

export function resolveArrowLabelPosition(
  input: ResolveArrowLabelPositionInput,
): ResolveArrowLabelPositionResult {
  const userSetOffset = input.offset !== undefined
  const baseOffset = input.offset ?? 6
  const width = estimateTextWidth(input.text)
  const obstacles = input.obstacles ?? []

  // For mostly vertical arrows, widen the default offset when needed so a wide
  // label stays entirely on one side of the line.
  let effectiveOffset = baseOffset
  if (!userSetOffset) {
    const dx = input.end.x - input.start.x
    const dy = input.end.y - input.start.y
    const length = Math.hypot(dx, dy)
    if (length > 0 && Math.abs(dy) > Math.abs(dx)) {
      effectiveOffset = Math.max(baseOffset, width / 2)
    }
  }

  // Default candidate. Outside the vertical-wide-label case, this matches the
  // previous behavior exactly.
  const defaultCandidate = buildCandidate(input, width, effectiveOffset, false, 0.5)

  if (obstacles.length === 0) {
    // Preserve the old behavior when no obstacles are provided.
    return strip(defaultCandidate)
  }

  // Collision helper.
  const collides = (rect: Rect): boolean => obstacles.some((o) => rectsOverlap(rect, o))

  if (!collides(defaultCandidate.rect)) {
    return strip(defaultCandidate)
  }

  // Search order: midpoint with varying offset/flip, then near-end positions.
  const offsetLadder = [
    effectiveOffset,
    effectiveOffset * 3,
    effectiveOffset * 6,
    effectiveOffset * 10,
  ]
  const tLadder = [0.5, 0.25, 0.75, 0.15, 0.85]
  const flipOptions = [false, true]

  for (const t of tLadder) {
    for (const off of offsetLadder) {
      for (const flip of flipOptions) {
        const cand = buildCandidate(input, width, off, flip, t)
        if (!collides(cand.rect)) {
          return strip(cand)
        }
      }
    }
  }

  // If everything collides, fall back to the default instead of throwing.
  return strip(defaultCandidate)
}

// Drop the internal rect field from the public return shape.
function strip(
  candidate: ResolveArrowLabelPositionResult & { rect: Rect },
): ResolveArrowLabelPositionResult {
  const { rect: _rect, ...rest } = candidate
  return rest
}
