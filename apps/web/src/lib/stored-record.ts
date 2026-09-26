import type { z } from 'zod'

/**
 * A keyed record read back from browser storage, ENTRY by entry: what parses
 * is kept, what does not is dropped on its own.
 *
 * The three stores this serves (daemon identity pins, registered passkeys,
 * wrapped replica keys) each read their whole record through one strict
 * schema, so a single entry it could not read made every entry read as
 * absent — and each then wrote back what it had just read, erasing the rest.
 * The likeliest such entry is not corruption but a NEWER build: it adds a
 * field, and an older tab still open reads that entry as unreadable under
 * `.strict()`. It should cost that entry, not every daemon's.
 *
 * Text that is not a JSON object has no entries to keep, so it reads as
 * empty, which is what each store already answered. Built with
 * `Object.fromEntries` rather than by assignment, because an entry keyed
 * `__proto__` assigned onto a plain object rewrites its prototype instead of
 * becoming an entry.
 */
export function readStoredRecord<T>(
  raw: string | null,
  entrySchema: z.ZodType<T>,
): Record<string, T> {
  if (raw === null) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  return Object.fromEntries(
    Object.entries(parsed).flatMap(([key, value]) => {
      const entry = entrySchema.safeParse(value)
      return entry.success ? [[key, entry.data] as const] : []
    }),
  )
}
