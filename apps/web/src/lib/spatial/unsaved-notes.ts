import { z } from 'zod'

const KEY_PREFIX = 'wb.unsaved-notes:'

const storedIdsSchema = z.array(z.string())

/**
 * The notes this tab made for an edit that has not ended yet, per document.
 * A page that is closed or reloaded mid-edit ends nothing, so the empty note
 * it made is still in the document; the next load in the same tab reads this
 * and removes it. Session-scoped on purpose: another tab's live edit of the
 * same document is not this tab's to remove.
 */
export function readUnsavedNotes(documentKey: string): string[] {
  try {
    const raw = sessionStorage.getItem(`${KEY_PREFIX}${documentKey}`)
    if (raw === null) return []
    const parsed = storedIdsSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : []
  } catch {
    // Unavailable storage or a damaged entry: an empty note left behind is the whole cost.
    return []
  }
}

function writeUnsavedNotes(documentKey: string, ids: readonly string[]): void {
  try {
    const key = `${KEY_PREFIX}${documentKey}`
    if (ids.length === 0) sessionStorage.removeItem(key)
    else sessionStorage.setItem(key, JSON.stringify(ids))
  } catch {
    // Losing the record leaves an empty note in place, which is what happened without it.
  }
}

export function rememberUnsavedNote(documentKey: string, id: string): void {
  const ids = readUnsavedNotes(documentKey)
  if (!ids.includes(id)) writeUnsavedNotes(documentKey, [...ids, id])
}

export function forgetUnsavedNote(documentKey: string, id: string): void {
  const ids = readUnsavedNotes(documentKey)
  if (ids.includes(id))
    writeUnsavedNotes(
      documentKey,
      ids.filter((other) => other !== id),
    )
}
