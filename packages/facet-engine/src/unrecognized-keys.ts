/**
 * Where a parsed payload lost a key the caller sent.
 *
 * A plain `z.object` strips an undeclared key and still succeeds, so a
 * misspelt field of a facet payload would be stored as its declared
 * remainder while the write reported success. `validateFacetWrite` keeps
 * answering the parsed value — the editor's derived form sends a draft that
 * still holds a previous variant's field and stores what the schema kept —
 * so a writer that cannot afford that (an agent's tool call, where the
 * caller reads the answer as "stored as sent") asks this of the pair.
 * Reading keeps stripping too: a bucket a newer build wrote must stay readable.
 *
 * Found by comparing the input with the parsed output rather than by
 * rewriting each schema strict: a plugin's schema is its own, and a refusal
 * that depended on every author remembering `.strict()` would be one more
 * convention nothing enforces. A catch-all (`z.record`, `.loose()`) keeps its
 * keys and is therefore never reported.
 */
export interface UnrecognizedKey {
  /** Dotted path to the object that held it; empty for the payload itself. */
  readonly path: readonly string[]
  readonly key: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export function firstUnrecognizedKey(
  sent: unknown,
  parsed: unknown,
  path: readonly string[] = [],
): UnrecognizedKey | undefined {
  if (Array.isArray(sent) && Array.isArray(parsed)) return inArray(sent, parsed, path)
  if (isRecord(sent) && isRecord(parsed)) return inRecord(sent, parsed, path)
  return undefined
}

function inArray(
  sent: readonly unknown[],
  parsed: readonly unknown[],
  path: readonly string[],
): UnrecognizedKey | undefined {
  for (let index = 0; index < sent.length; index += 1) {
    const found = firstUnrecognizedKey(sent[index], parsed[index], [...path, String(index)])
    if (found !== undefined) return found
  }
  return undefined
}

function inRecord(
  sent: Record<string, unknown>,
  parsed: Record<string, unknown>,
  path: readonly string[],
): UnrecognizedKey | undefined {
  for (const [key, value] of Object.entries(sent)) {
    // `undefined` is what an optional field looks like once JSON is gone,
    // and no schema is obliged to keep it.
    if (value === undefined) continue
    if (!(key in parsed)) return { path, key }
    const found = firstUnrecognizedKey(value, parsed[key], [...path, key])
    if (found !== undefined) return found
  }
  return undefined
}

/** The refusal sentence for one, in zod's own wording for a strict object. */
export function describeUnrecognizedKey(stray: UnrecognizedKey): string {
  const where = stray.path.length === 0 ? 'payload' : stray.path.join('.')
  return `${where}: Unrecognized key: "${stray.key}"`
}
