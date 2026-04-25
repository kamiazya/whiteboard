import { LoroDoc, LoroMap } from 'loro-crdt'
import type { Value } from 'loro-crdt'
import type { BinaryFileData } from '@excalidraw/excalidraw/types'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import { uploadFiles } from './upload-files.js'

function valuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return false
    for (let i = 0; i < left.length; i++) {
      if (!valuesEqual(left[i], right[i])) return false
    }
    return true
  }
  if (
    left !== null &&
    right !== null &&
    typeof left === 'object' &&
    typeof right === 'object'
  ) {
    const leftEntries = Object.entries(left).sort(([a], [b]) => a.localeCompare(b))
    const rightEntries = Object.entries(right).sort(([a], [b]) => a.localeCompare(b))
    if (leftEntries.length !== rightEntries.length) return false
    for (let i = 0; i < leftEntries.length; i++) {
      const leftEntry = leftEntries[i]
      const rightEntry = rightEntries[i]
      if (!leftEntry || !rightEntry) return false
      const [leftKey, leftValue] = leftEntry
      const [rightKey, rightValue] = rightEntry
      if (leftKey !== rightKey || !valuesEqual(leftValue, rightValue)) {
        return false
      }
    }
    return true
  }
  return false
}

function elementsEqual(
  current: readonly ExcalidrawElement[],
  next: readonly ExcalidrawElement[],
): boolean {
  if (current.length !== next.length) return false
  for (let i = 0; i < current.length; i++) {
    if (!valuesEqual(current[i], next[i])) return false
  }
  return true
}

// Apply the Excalidraw onChange delta to the Loro document.
// This follows the same general pattern as loro-excalidraw, but is implemented locally.
export function recordLocalOps(doc: LoroDoc, nextElements: ExcalidrawElement[]) {
  const list = doc.getMovableList('elements')
  const current = list.toJSON() as ExcalidrawElement[]

  if (elementsEqual(current, nextElements)) {
    return false
  }

  // Append newly added elements.
  const currentIds = new Set(current.map((e) => e.id))
  for (const el of nextElements) {
    if (!currentIds.has(el.id)) {
      const map = list.insertContainer(list.length, new LoroMap())
      for (const [k, v] of Object.entries(el)) {
        if (v !== undefined) map.set(k, v as Value)
      }
    }
  }

  // Update changed elements field-by-field with set/delete operations.
  const nextElementsById = new Map(nextElements.map((element) => [element.id, element]))
  for (let i = 0; i < list.length; i++) {
    const item = list.get(i)
    if (!(item instanceof LoroMap)) continue
    const id = item.get('id') as string
    const next = nextElementsById.get(id)
    if (!next) continue

    for (const [k, v] of Object.entries(next)) {
      const cur = item.get(k)
      const changed =
        Array.isArray(v) || (v !== null && typeof v === 'object')
          ? JSON.stringify(cur) !== JSON.stringify(v)
          : cur !== v
      if (changed) item.set(k, v as Value)
    }

    const nextKeys = new Set(Object.keys(next))
    for (const key of Object.keys(item.toJSON() as Record<string, unknown>)) {
      if (!nextKeys.has(key)) item.delete(key)
    }
  }

  return true
}

/**
 * Upload files before committing the document.
 *
 * Capture `doc` at invocation time and pass that value in.
 * Do not pass `docRef.current` directly, or stale-closure bugs can leak the
 * commit into the wrong canvas.
 *
 * - no new files: commit immediately
 * - new files present: commit after `uploadFiles` finishes
 * - upload failure: reject and skip the commit
 */
export async function commitAfterUpload(
  newEntries: [string, BinaryFileData][],
  doc: LoroDoc,
  elements: ExcalidrawElement[],
  sessionId: string,
  slug: string,
  onFileSuccess: (fileId: string) => void,
): Promise<void> {
  if (newEntries.length > 0) {
    await uploadFiles(newEntries, sessionId, slug, onFileSuccess)
  }
  if (!recordLocalOps(doc, elements)) {
    return
  }
  doc.commit()
}
