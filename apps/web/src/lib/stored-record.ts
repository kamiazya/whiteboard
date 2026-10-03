import type { z } from 'zod'

/**
 * A keyed record read back from browser storage, ENTRY by entry: what parses
 * is kept, what does not is set aside on its own.
 *
 * The stores this serves (registered passkeys, wrapped replica keys) each
 * read their whole record through one strict schema, so a single entry it
 * could not read made every entry read as absent — and each then wrote back
 * what it had just read, erasing the rest. The likeliest such entry is not
 * corruption but a NEWER build: it adds a field, and an older tab still open
 * reads that entry as unreadable under `.strict()`. It should cost that
 * entry, not every daemon's.
 *
 * Reading drops the unreadable entry from `entries`, so the store answers
 * absent for it; writing carries it through verbatim (`unread`), so a save or
 * a drop of ANOTHER key does not erase it. These entries are sealed workspace
 * keys and offline passkey pins: losing one costs a passkey ceremony the newer
 * build's tab already paid.
 *
 * That is deliberately not the settings store's policy
 * (`user-settings-store.ts`), where a tab's next write drops the fields it
 * does not know: settings are one object a newer build may reshape and an
 * older one can re-derive from defaults, while each entry here is independent
 * secret-bearing state with no default to fall back to.
 *
 * Only where a dropped entry reads as a safe absence: a store where an
 * unreadable entry must stay distinguishable from a missing one cannot use it.
 *
 * Text that is not a JSON object has no entries to keep, so it reads as
 * empty, which is what each store already answered. Built with
 * `Object.fromEntries` rather than by assignment, because an entry keyed
 * `__proto__` assigned onto a plain object rewrites its prototype instead of
 * becoming an entry.
 */
export interface StoredRecord<T> {
  /** The entries this build can read. */
  entries: Record<string, T>
  /** The entries it cannot, exactly as stored. */
  unread: Record<string, unknown>
}

export function readStoredRecord<T>(
  raw: string | null,
  entrySchema: z.ZodType<T>,
): StoredRecord<T> {
  const empty: StoredRecord<T> = { entries: {}, unread: {} }
  if (raw === null) return empty
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return empty
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return empty
  const read = Object.entries(parsed).map(([key, value]) => {
    const entry = entrySchema.safeParse(value)
    return { key, value, entry }
  })
  return {
    entries: Object.fromEntries(
      read.flatMap(({ key, entry }) => (entry.success ? [[key, entry.data] as const] : [])),
    ),
    unread: Object.fromEntries(
      read.flatMap(({ key, value, entry }) => (entry.success ? [] : [[key, value] as const])),
    ),
  }
}

/** Text for storage: the unreadable entries carried through, a readable entry winning a shared key. */
export function serializeStoredRecord<T>({ entries, unread }: StoredRecord<T>): string {
  return JSON.stringify({ ...unread, ...entries })
}

/** The record with one entry written; an unreadable entry under the same key is replaced. */
export function withStoredEntry<T>(
  record: StoredRecord<T>,
  key: string,
  entry: T,
): StoredRecord<T> {
  return { ...record, entries: { ...record.entries, [key]: entry } }
}

/** The record with one key gone, whether this build could read its entry or not. */
export function withoutStoredEntry<T>(record: StoredRecord<T>, key: string): StoredRecord<T> {
  const { [key]: _entry, ...entries } = record.entries
  const { [key]: _unread, ...unread } = record.unread
  return { entries, unread }
}
