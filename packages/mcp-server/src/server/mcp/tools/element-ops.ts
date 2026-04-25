import type { LoroDoc, LoroMap } from 'loro-crdt'
import { definedProps } from '../../defined-props.js'
import { snapArrowEndpoints, type Rect } from './snap-arrow.js'

// Scan the Excalidraw element list (doc.getMovableList('elements')) and return the
// LoroMap for the requested id, or undefined when it is missing. Like annotate.ts,
// these helpers mutate the doc directly as pure Loro operations.
function findElementMap(doc: LoroDoc, elementId: string): LoroMap | undefined {
  const list = doc.getMovableList('elements')
  for (let i = 0; i < list.length; i++) {
    const item = list.get(i) as unknown
    // LoroMap is runtime-checkable with instanceof, but the typings return any, so use duck typing.
    if (item && typeof (item as LoroMap).get === 'function') {
      const map = item as LoroMap
      if (map.get('id') === elementId) return map
    }
  }
  return undefined
}

function requireElementMap(doc: LoroDoc, elementId: string): LoroMap {
  const map = findElementMap(doc, elementId)
  if (!map) throw new Error(`element not found: ${elementId}`)
  return map
}

function rectFromMap(map: LoroMap): Rect {
  return {
    x: (map.get('x') as number) ?? 0,
    y: (map.get('y') as number) ?? 0,
    width: (map.get('width') as number) ?? 0,
    height: (map.get('height') as number) ?? 0,
  }
}

function readBoundArrowIds(map: LoroMap): string[] {
  const raw = map.get('boundElements')
  if (!Array.isArray(raw)) return []
  return raw
    .filter(
      (value): value is { id: string; type: string } =>
        typeof value === 'object' &&
        value !== null &&
        typeof (value as { id?: unknown }).id === 'string' &&
        typeof (value as { type?: unknown }).type === 'string',
    )
    .filter((value) => value.type === 'arrow')
    .map((value) => value.id)
}

// Apply an arbitrary field patch to a single element.
// This assumes known Excalidraw element fields (x/y/width/height/strokeColor/...),
// while value validation is delegated to the caller (the MCP tool schema).
export function applyUpdate(
  doc: LoroDoc,
  elementId: string,
  patch: Record<string, unknown>,
): void {
  const map = requireElementMap(doc, elementId)
  for (const [k, v] of Object.entries(patch)) {
    map.set(k, v as never)
  }
}

// Soft-delete (tombstone) an element by setting isDeleted=true. The element stays
// in the LoroList so the CRDT delete operation still propagates.
export function applyDelete(doc: LoroDoc, elementId: string): void {
  const map = requireElementMap(doc, elementId)
  map.set('isDeleted', true)
}

// Tombstone multiple elements in one all-or-nothing operation. Duplicate ids are
// deduped, already-deleted ids stay idempotent, and the return value preserves input order.
export function applyDeleteMany(doc: LoroDoc, elementIds: string[]): string[] {
  if (elementIds.length === 0) return []
  const unique: string[] = []
  const seen = new Set<string>()
  for (const id of elementIds) {
    if (!seen.has(id)) {
      seen.add(id)
      unique.push(id)
    }
  }
  // Pre-check every id first so the operation stays all-or-nothing.
  const maps = unique.map((id) => requireElementMap(doc, id))
  for (const map of maps) {
    map.set('isDeleted', true)
  }
  return unique
}

// Tombstone every non-deleted element. Used by canvas_clear and remains idempotent.
export function applyClear(doc: LoroDoc): number {
  const list = doc.getMovableList('elements')
  let cleared = 0
  for (let i = 0; i < list.length; i++) {
    const item = list.get(i) as unknown
    if (!item || typeof (item as LoroMap).get !== 'function') continue
    const map = item as LoroMap
    if (map.get('isDeleted') === true) continue
    map.set('isDeleted', true)
    cleared += 1
  }
  return cleared
}

// Logical group operations.
// Use Excalidraw's native `groupIds: string[]` to associate elements logically.
// This is used for section-level rewrite/delete flows on the design canvas.
// groupId is an arbitrary caller-provided string (for example "section-11" or
// "sec-11-before"), and one element may belong to multiple groups.
//
// If you need a visible frame, use annotate type:'group' to draw a bounding rect.
// The helpers here are purely logical grouping.

function readGroupIds(map: LoroMap): string[] {
  const raw = map.get('groupIds')
  if (!Array.isArray(raw)) return []
  return (raw as unknown[]).filter((v): v is string => typeof v === 'string')
}

// Append groupId to every member's groupIds array. Existing membership is a no-op.
export function applyAssignToGroup(
  doc: LoroDoc,
  groupId: string,
  memberIds: string[],
): void {
  if (memberIds.length === 0) return
  const maps = memberIds.map((id) => requireElementMap(doc, id))
  for (const map of maps) {
    const current = readGroupIds(map)
    if (current.includes(groupId)) continue
    map.set('groupIds', [...current, groupId])
  }
}

// Return ids of non-deleted elements in the given groupId.
export function listElementsInGroup(doc: LoroDoc, groupId: string): string[] {
  const list = doc.getMovableList('elements')
  const snap = list.toJSON() as Array<Record<string, unknown>>
  const out: string[] = []
  for (const el of snap) {
    if (el.isDeleted === true) continue
    const gs = Array.isArray(el.groupIds) ? (el.groupIds as unknown[]) : []
    if (gs.includes(groupId) && typeof el.id === 'string') out.push(el.id)
  }
  return out
}

// Return the current (groupId, memberIds) listing for the canvas, excluding tombstones.
export function listGroups(doc: LoroDoc): { groupId: string; memberIds: string[] }[] {
  const list = doc.getMovableList('elements')
  const snap = list.toJSON() as Array<Record<string, unknown>>
  const byGroup = new Map<string, string[]>()
  for (const el of snap) {
    if (el.isDeleted === true) continue
    if (typeof el.id !== 'string') continue
    const gs = Array.isArray(el.groupIds) ? (el.groupIds as unknown[]) : []
    for (const g of gs) {
      if (typeof g !== 'string') continue
      const arr = byGroup.get(g) ?? []
      arr.push(el.id)
      byGroup.set(g, arr)
    }
  }
  return Array.from(byGroup.entries()).map(([groupId, memberIds]) => ({ groupId, memberIds }))
}

// Tombstone all non-deleted members of the given group and return their ids.
export function applyDeleteGroup(doc: LoroDoc, groupId: string): string[] {
  const targets = listElementsInGroup(doc, groupId)
  if (targets.length === 0) return []
  for (const id of targets) {
    const map = requireElementMap(doc, id)
    map.set('isDeleted', true)
  }
  return targets
}

// Move multiple elements by the same dx/dy in one all-or-nothing operation.
export function applyMove(
  doc: LoroDoc,
  elementIds: string[],
  dx: number,
  dy: number,
): void {
  // Pre-check that every id exists before mutating the doc.
  const maps: LoroMap[] = elementIds.map((id) => requireElementMap(doc, id))
  if (dx === 0 && dy === 0) return
  for (const map of maps) {
    const x = (map.get('x') as number) ?? 0
    const y = (map.get('y') as number) ?? 0
    map.set('x', x + dx)
    map.set('y', y + dy)
  }

  const arrowIds = new Set<string>()
  for (const map of maps) {
    for (const arrowId of readBoundArrowIds(map)) {
      arrowIds.add(arrowId)
    }
  }
  for (const arrowId of arrowIds) {
    const arrowMap = findElementMap(doc, arrowId)
    if (!arrowMap) continue
    const startBoxId = arrowMap.get('startBoxId') as string | undefined
    const endBoxId = arrowMap.get('endBoxId') as string | undefined
    const points = (arrowMap.get('points') as [number, number][] | undefined) ?? []
    if (points.length < 2) continue
    const currentStart = {
      x: ((arrowMap.get('x') as number) ?? 0) + points[0]![0],
      y: ((arrowMap.get('y') as number) ?? 0) + points[0]![1],
    }
    const currentEnd = {
      x: ((arrowMap.get('x') as number) ?? 0) + points[points.length - 1]![0],
      y: ((arrowMap.get('y') as number) ?? 0) + points[points.length - 1]![1],
    }
    const startBox = startBoxId ? rectFromMap(requireElementMap(doc, startBoxId)) : undefined
    const endBox = endBoxId ? rectFromMap(requireElementMap(doc, endBoxId)) : undefined
    const snapped = snapArrowEndpoints({
      start: startBox
        ? { x: startBox.x + startBox.width / 2, y: startBox.y + startBox.height / 2 }
        : currentStart,
      end: endBox
        ? { x: endBox.x + endBox.width / 2, y: endBox.y + endBox.height / 2 }
        : currentEnd,
      ...definedProps({ startBox, endBox }),
    })
    arrowMap.set('x', snapped.start.x)
    arrowMap.set('y', snapped.start.y)
    arrowMap.set(
      'points',
      [
        [0, 0],
        [snapped.end.x - snapped.start.x, snapped.end.y - snapped.start.y],
      ] as Parameters<LoroMap['set']>[1],
    )
    arrowMap.set('width', Math.abs(snapped.end.x - snapped.start.x))
    arrowMap.set('height', Math.abs(snapped.end.y - snapped.start.y))
  }
}

// Reorder z-index while preserving the selected ids' current relative order,
// moving them together to the back or front without creating extra tombstones.
export function applyReorder(
  doc: LoroDoc,
  elementIds: string[],
  action: 'front' | 'back',
): void {
  if (elementIds.length === 0) return
  // Pre-check.
  for (const id of elementIds) requireElementMap(doc, id)

  const list = doc.getMovableList('elements')
  const idSet = new Set(elementIds)

  // Target ids in current list order. Keep the current relative order for front and back moves.
  const orderedIds: string[] = []
  for (let i = 0; i < list.length; i++) {
    const item = list.get(i) as LoroMap | undefined
    const id = item?.get('id') as string | undefined
    if (id && idSet.has(id)) orderedIds.push(id)
  }

  const findIdxById = (id: string): number => {
    for (let i = 0; i < list.length; i++) {
      const item = list.get(i) as LoroMap | undefined
      if (item && item.get('id') === id) return i
    }
    return -1
  }

  if (action === 'front') {
    // Move to the end in current order. After each move, the element is already
    // at the tail, so re-searching yields the correct next target index.
    for (const id of orderedIds) {
      const idx = findIdxById(id)
      if (idx !== -1 && idx !== list.length - 1) list.move(idx, list.length - 1)
    }
  } else {
    // Move to the front in current order, targeting 0, 1, 2, ... in sequence.
    // Elements placed earlier occupy 0..i-1, so re-search before each move.
    for (let i = 0; i < orderedIds.length; i++) {
      const targetId = orderedIds[i]
      if (!targetId) continue
      const idx = findIdxById(targetId)
      if (idx !== -1 && idx !== i) list.move(idx, i)
    }
  }
}
