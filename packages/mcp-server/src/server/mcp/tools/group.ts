// Pure helper that expands a group composite annotation into two specs:
// a bounding rect plus an optional title. It builds the rect from the bbox of
// existing elements selected by memberIds, with padding applied. When title is
// present, it adds a separate text element 14px above the rect using the same
// placement rule as box_with_label with subTextPosition='top'.
//
// This function only reads existing ExcalidrawElement[] data and is independent
// from doc writes. Upstream callers (annotate / annotate_batch) decompose the
// spec with this helper after fetching a snapshot, then pass the result into
// appendAnnotationToDoc.

import type { RectSpec, TextSpec } from './box-with-label.js'

// Match title font size and gap to box_with_label subText.
const TITLE_FONT_SIZE = 14
const LINE_HEIGHT_RATIO = 1.25
const TITLE_GAP = 6
const DEFAULT_PADDING = 20

interface GroupMemberElement {
  id: string
  x: number
  y: number
  width: number
  height: number
  isDeleted?: boolean
}

export interface GroupInput {
  elements: GroupMemberElement[]
  memberIds: string[]
  padding?: number
  title?: string | string[]
  color?: string
  templateInstanceId?: string
}

export interface GroupDiagnostics {
  missingMemberIds: string[]
}

export function decomposeGroup(
  input: GroupInput,
): [RectSpec | undefined, TextSpec | undefined, GroupDiagnostics] {
  const padding = input.padding ?? DEFAULT_PADDING
  // Reverse index of non-deleted elements by id. Deleted elements count as missing.
  const byId = new Map<string, GroupMemberElement>()
  for (const el of input.elements) {
    if (el.isDeleted) continue
    byId.set(el.id, el)
  }

  const existing: GroupMemberElement[] = []
  const missingMemberIds: string[] = []
  for (const id of input.memberIds) {
    const el = byId.get(id)
    if (el) existing.push(el)
    else missingMemberIds.push(id)
  }

  if (existing.length === 0) {
    return [undefined, undefined, { missingMemberIds }]
  }

  // bbox = min(x) / min(y) / max(right) / max(bottom)
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxRight = Number.NEGATIVE_INFINITY
  let maxBottom = Number.NEGATIVE_INFINITY
  for (const el of existing) {
    if (el.x < minX) minX = el.x
    if (el.y < minY) minY = el.y
    const right = el.x + el.width
    const bottom = el.y + el.height
    if (right > maxRight) maxRight = right
    if (bottom > maxBottom) maxBottom = bottom
  }

  const rect: RectSpec = {
    type: 'rectangle',
    target: { x: minX - padding, y: minY - padding },
    width: maxRight - minX + padding * 2,
    height: maxBottom - minY + padding * 2,
    color: input.color,
    templateInstanceId: input.templateInstanceId,
  }

  if (input.title === undefined) {
    return [rect, undefined, { missingMemberIds }]
  }

  const titleLines = Array.isArray(input.title) ? input.title : [input.title]
  const titleHeight = titleLines.length * TITLE_FONT_SIZE * LINE_HEIGHT_RATIO
  const title: TextSpec = {
    type: 'text',
    target: { x: rect.target.x, y: rect.target.y - titleHeight - TITLE_GAP },
    text: titleLines.join('\n'),
    width: rect.width,
    height: titleHeight,
    color: input.color,
    templateInstanceId: input.templateInstanceId,
  }

  return [rect, title, { missingMemberIds }]
}
