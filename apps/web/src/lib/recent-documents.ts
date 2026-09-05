/**
 * What this device opened recently, per workspace.
 *
 * Deliberately NOT synced. "Recently opened" is a record of what happened on
 * THIS device, so a phone and a desktop holding different answers is the
 * correct behaviour rather than a gap — and keeping it out of the document
 * model means no schema change and identical behaviour whether the workspace
 * is kept by the browser or by the daemon (owner decision, 2026-09-05).
 *
 * Ids, not paths: a rename must not drop a document out of the lane, and a
 * path freed by a rename can be taken by a different document.
 */

import { z } from 'zod'

// Namespaced + version-suffixed, like `user-settings-store.ts`. This payload
// is disposable — losing it costs a lane, not a setting — so a breaking change
// here may bump the key without a migration, which is the one way it differs.
export const STORAGE_KEY = 'whiteboard:recent-documents:v1'

/**
 * How many the lane remembers.
 *
 * A lane is a shortcut, not a history: past a handful it becomes a second
 * list to search, which is the cost the grid already pays and the reason the
 * lane exists.
 */
export const RECENT_CAP = 8

// Per workspace handle, most recent first. A workspace whose entry fails to
// parse degrades to empty ON ITS OWN rather than discarding every other
// workspace's lane with it — the whole-payload discard is the trap
// `user-settings-store.ts` records paying for.
const storedSchema = z.record(z.string(), z.array(z.string()).catch([]))

/**
 * The pure ranking step: `id` to the head, no duplicates, never past the cap.
 *
 * Separated from storage so the invariants can be stated as properties
 * (`recent-documents.property.test.ts`) without a DOM.
 */
export function recordRecentId(existing: readonly string[], id: string): readonly string[] {
  const rest = existing.filter((each, i) => each !== id && existing.indexOf(each) === i)
  return [id, ...rest].slice(0, RECENT_CAP)
}

// localStorage access itself throws when a browser blocks storage
// (SecurityError, privacy settings or an embedded context), so the guard has
// to sit around the ACCESS and not only around the parse. Contract: neither
// of these ever throws, and the picker renders with an empty lane instead.
function readAll(): Record<string, readonly string[]> {
  let raw: string | null
  try {
    raw = localStorage.getItem(STORAGE_KEY)
  } catch {
    return {}
  }
  if (raw === null) return {}
  try {
    const parsed = storedSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : {}
  } catch {
    return {}
  }
}

/**
 * One workspace's list, by OWN key only.
 *
 * A handle is text the user chose — `deriveWorkspaceSegment` lowercases a
 * display name, and `constructor` passes the segment charset — so a plain
 * object answers some handles with an INHERITED member. That value is
 * truthy, so `?? []` never fires: the lane was handed `Object.prototype`'s
 * constructor and threw on `.map`, crashing the whole panel for anyone whose
 * workspace was named that, with storage empty and no way to clear it.
 *
 * Nothing is ever WRITTEN to the prototype — a computed key in an object
 * literal defines an own property rather than invoking the `__proto__`
 * setter — so this is a read-side confusion, not pollution.
 */
function scopeOf(all: Record<string, readonly string[]>, workspace: string): readonly string[] {
  return Object.hasOwn(all, workspace) ? (all[workspace] ?? []) : []
}

export function readRecentIds(workspace: string): readonly string[] {
  return scopeOf(readAll(), workspace)
}

export function recordRecentDocument(workspace: string, documentId: string): void {
  const all = readAll()
  const next = { ...all, [workspace]: recordRecentId(scopeOf(all, workspace), documentId) }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // An unwritable storage degrades to not remembering, never to a failed open.
  }
}
