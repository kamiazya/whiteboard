/**
 * Reads one of the plugin's asset JSON files (`assets/`) as the typed table
 * the registry and renderers consume.
 *
 * The files are the single source of the bundled assets' values: the Rust
 * core embeds the same bytes. TypeScript therefore never re-states them, only
 * judges them — each entry against the engine's schema for its kind — and
 * hands back the ORIGINAL objects, not the schema's parse of them, so key
 * order and every number stay exactly as the file wrote them.
 */
import type { z } from 'zod'

export function assetTable<Asset>(
  what: string,
  table: Readonly<Record<string, unknown>>,
  schema: z.ZodType<Asset>,
): Readonly<Record<string, Asset>> {
  const accepted = (entry: unknown): entry is Asset => schema.safeParse(entry).success
  return Object.fromEntries(
    Object.entries(table).map(([name, entry]) => {
      if (!accepted(entry)) {
        const why = schema
          .safeParse(entry)
          .error?.issues.map((issue) => issue.message)
          .join('; ')
        throw new Error(`${what} asset "${name}" is not valid: ${why}`)
      }
      return [name, entry]
    }),
  )
}
