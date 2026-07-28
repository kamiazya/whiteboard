import { z } from 'zod'

/**
 * Shape persisted under `doc.getMap('versions').get(versionId)` by
 * version-save.ts, and re-hydrated by both version-list.ts and
 * version-restore.ts. Declaring it once here keeps the read sites from
 * independently re-deriving (and silently drifting from) the write side's
 * contract.
 */
export const versionRecordSchema = z
  .object({
    label: z.string(),
    timestamp: z.string(),
    frontier: z.string(),
  })
  .strict()
export type VersionRecord = z.infer<typeof versionRecordSchema>

/**
 * Parses a raw JSON string from the `versions` map into a `VersionRecord`.
 * Returns `null` on any failure (malformed JSON or schema mismatch) so
 * callers can treat a corrupt/unrecognized stored entry as "not found"
 * rather than crashing.
 */
export function parseVersionRecord(raw: string): VersionRecord | null {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return null
  }
  const result = versionRecordSchema.safeParse(json)
  return result.success ? result.data : null
}
