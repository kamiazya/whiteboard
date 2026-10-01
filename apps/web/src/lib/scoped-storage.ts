/**
 * One localStorage key holding a record, read under a schema and written
 * whole. Contract: neither function throws — a device whose storage is
 * blocked, full, or holding something this code did not write behaves as an
 * empty one, so a per-device convenience never fails the action it decorates.
 */

import type { z } from 'zod'

/**
 * The guard sits around the ACCESS and not only around the parse: a browser
 * that blocks storage (privacy settings, an embedded context) raises on the
 * `localStorage` property itself, before any method is called.
 */
export function readScopedStorage<T>(
  key: string,
  schema: z.ZodType<Record<string, T>>,
): Record<string, T> {
  let raw: string | null
  try {
    raw = localStorage.getItem(key)
  } catch {
    return {}
  }
  if (raw === null) return {}
  try {
    const parsed = schema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : {}
  } catch {
    return {}
  }
}

export function writeScopedStorage(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // An unwritable storage degrades to not remembering.
  }
}

/**
 * One key's value, by OWN key only.
 *
 * A key here is text the user chose — a workspace handle (`constructor`
 * passes the segment charset, and `deriveWorkspaceSegment` lowercases a
 * display name) — and a plain object answers some of those with an INHERITED
 * member. That value is truthy, so `??` never fires: the caller was handed
 * `Object.prototype`'s constructor and threw on it, crashing a whole panel
 * with storage empty and no way to clear it.
 *
 * Nothing is ever WRITTEN to the prototype — a computed key in an object
 * literal defines an own property rather than invoking the `__proto__`
 * setter — so this is a read-side confusion, not pollution.
 */
export function ownValue<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined
}
