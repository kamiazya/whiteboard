/**
 * The records under a map-shaped container that the schema accepts, in the
 * container's key order.
 *
 * A record the schema rejects costs that record and nothing beside it — the
 * contract every reader in this package keeps, written once here rather than
 * as the same loop in each reader. Absent container, no records.
 *
 * The schema is typed by the one method used, so this package stays free of a
 * direct zod dependency while taking any zod schema as it is.
 */
export function acceptedEntries<T>(
  container: { keys(): Iterable<string>; get(key: string): unknown } | undefined,
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
): T[] {
  if (container === undefined) return []
  const accepted: T[] = []
  for (const key of container.keys()) {
    const parsed = schema.safeParse(container.get(key))
    if (parsed.success) accepted.push(parsed.data)
  }
  return accepted
}
