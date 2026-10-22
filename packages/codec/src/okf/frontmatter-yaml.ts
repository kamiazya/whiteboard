import { isAlias, isCollection, isScalar, parseDocument, visit } from 'yaml'

/**
 * The integer an unsafe-range scalar was WRITTEN as, or `undefined` when the
 * double holds it as well as a double can: it is exact, or it is the very
 * digits JS prints for that double (`serializeOkf` writes those, so a stored
 * double must read back as itself).
 */
function writtenInteger(source: string, parsed: number): bigint | undefined {
  try {
    const written = BigInt(source.replace(/^\+/, ''))
    return written === BigInt(parsed) || String(written) === String(parsed) ? undefined : written
  } catch {
    // Not an integer spelling (`1e20`): the number IS what was written.
    return undefined
  }
}

/**
 * Throws on a YAML anchor or alias. OKF gives them no meaning, and an alias
 * resolves to the SAME value as its anchor: a hundred aliases of one large
 * list read as a hundred copies everywhere downstream walks, stores and
 * re-serialises the frontmatter, for the bytes of one.
 */
function refuseAnchor(node: unknown): void {
  if (isAlias(node)) {
    throw new Error(
      `YAML anchors and aliases are not allowed in OKF frontmatter (found *${node.source})`,
    )
  }
  if ((isScalar(node) || isCollection(node)) && node.anchor !== undefined) {
    throw new Error(
      `YAML anchors and aliases are not allowed in OKF frontmatter (found &${node.anchor})`,
    )
  }
}

/**
 * Most collections one frontmatter value may sit inside, the root mapping
 * included. A facet payload is a handful of levels deep; past this the
 * nesting is no structure a reader uses, while `serializeOkf` writes each
 * mapping level two spaces further in, so a block-style read and export of
 * a value D levels deep is about D² characters.
 */
const MAX_FRONTMATTER_DEPTH = 32

/** Throws once `node` would sit deeper than MAX_FRONTMATTER_DEPTH collections. */
function refuseDeepNesting(node: unknown, path: readonly unknown[]): void {
  if (!isCollection(node)) return
  let depth = 1
  for (const ancestor of path) if (isCollection(ancestor)) depth += 1
  if (depth > MAX_FRONTMATTER_DEPTH) {
    throw new Error(
      `OKF frontmatter may nest at most ${MAX_FRONTMATTER_DEPTH} levels of mappings and lists`,
    )
  }
}

/**
 * YAML to a JS value, except that an integer written past 2^53 comes back as
 * the bigint it was written as instead of the neighbouring double it rounds
 * to. The rounded number cannot be told from an exact one afterwards, so it
 * would be stored as a different value than the author wrote; a bigint is
 * what `yamlSafeValueSchema` already refuses, which turns the loss into the
 * write-time refusal naming the key.
 *
 * Errors throw as `yaml`'s `parse` throws them, and so do an anchor or alias
 * and nesting past MAX_FRONTMATTER_DEPTH. Its warnings (an unresolved tag)
 * are not forwarded: the value is already what the document says.
 */
export function parseYamlKeepingWrittenIntegers(text: string): unknown {
  // Pinned, because a `%YAML 1.1` directive otherwise switches the reader to
  // 1.1's rules: `<<` merges one mapping into another and `yes` reads as a
  // boolean, key or value. OKF frontmatter is YAML 1.2.
  const doc = parseDocument(text, { version: '1.2', schema: 'core', merge: false })
  const [firstError] = doc.errors
  if (firstError !== undefined) throw firstError
  visit(doc, (_key, node, path) => {
    refuseAnchor(node)
    refuseDeepNesting(node, path)
    if (!isScalar(node) || typeof node.value !== 'number') return
    if (!Number.isInteger(node.value) || Number.isSafeInteger(node.value)) return
    const written =
      typeof node.source === 'string' ? writtenInteger(node.source, node.value) : undefined
    if (written !== undefined) node.value = written
  })
  return doc.toJS()
}
