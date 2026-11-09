import {
  isAlias,
  isCollection,
  isMap,
  isPair,
  isScalar,
  isSeq,
  parseDocument,
  Scalar,
  visit,
} from 'yaml'

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
 * Frontmatter is read as a restricted subset of YAML 1.2, small enough that a
 * second reader (the Rust core's) can implement it exactly and agree with this
 * one in both directions. Everything `serializeOkf` writes is inside it; what
 * a hand-written document may add beyond it is refused here, by name, instead
 * of being read by one implementation and misread by the other.
 */
const NOT_ALLOWED = 'in OKF frontmatter'

/** The longest key, as written, that `yaml` keeps inline; a longer one is written `? key`. */
const MAX_IMPLICIT_KEY_UNITS = 1024

/**
 * Refusals that need only the source text. They run before the parse so a
 * construct the parser would reject with its own wording is named in ours.
 * CRLF is a line ending; a CR alone is not.
 */
function refuseUnreadableText(text: string): void {
  if (text.includes('\uFEFF')) {
    throw new Error(`a byte-order mark is not allowed ${NOT_ALLOWED}`)
  }
  if (/\r(?!\n)/.test(text)) {
    throw new Error(`a carriage return outside a CRLF line ending is not allowed ${NOT_ALLOWED}`)
  }
  // Tab is the one C0 character YAML allows inside a line, and LF the line end.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to match them
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) {
    throw new Error(
      `raw control characters are not allowed ${NOT_ALLOWED}; write them as an escape inside double quotes`,
    )
  }
  // `^` with the `m` flag also breaks at U+2028 and U+2029, which YAML 1.2
  // does not treat as line breaks; only LF starts a line here.
  if (/(?:^|\n) *\t/.test(text)) {
    throw new Error(`a tab at the start of a line (indentation) is not allowed ${NOT_ALLOWED}`)
  }
  if (/(?:^|\n)(?:---|\.\.\.)(?=[ \t\r\n]|$)/.test(text) || /(?:^|\n)%/.test(text)) {
    throw new Error(`document markers and directives are not allowed ${NOT_ALLOWED}`)
  }
}

/** Throws on a tag: an explicit one is the only kind a parsed node carries. */
function refuseTag(node: unknown): void {
  if ((isScalar(node) || isCollection(node)) && node.tag !== undefined) {
    throw new Error(`tags are not allowed ${NOT_ALLOWED} (found ${node.tag})`)
  }
}

/** Throws on the key shapes the subset leaves out. */
function refuseUnsupportedKeys(text: string, node: unknown, parent: unknown): void {
  // `yaml` hands `[a: 1]` over as a one-pair mapping with no brace of its own.
  if (
    isSeq(node) &&
    node.flow === true &&
    node.items.some((item) => isMap(item) && item.range != null && text[item.range[0]] !== '{')
  ) {
    throw new Error(`a pair inside a flow list is not allowed ${NOT_ALLOWED}`)
  }
  if (!isPair(node)) return
  if (isCollection(node.key)) {
    throw new Error(`collection keys are not allowed ${NOT_ALLOWED}`)
  }
  const explicit = node.srcToken?.start.some((token) => token.type === 'explicit-key-ind') === true
  if (explicit) {
    // The one explicit key `yaml.stringify` writes is a block mapping's
    // scalar key whose WRITTEN form (quotes and escapes counted) passes
    // MAX_IMPLICIT_KEY_UNITS; any other is a spelling of a plain key.
    const longKey =
      isMap(parent) &&
      parent.flow !== true &&
      isScalar(node.key) &&
      node.key.range != null &&
      node.key.range[1] - node.key.range[0] > MAX_IMPLICIT_KEY_UNITS
    if (!longKey) {
      throw new Error(
        `explicit keys are not allowed ${NOT_ALLOWED} (found ? for a key written in ${MAX_IMPLICIT_KEY_UNITS} units or fewer, or inside a flow collection)`,
      )
    }
    return
  }
  if (isScalar(node.key) && node.key.range != null && node.key.range[0] === node.key.range[1]) {
    throw new Error(`empty keys are not allowed ${NOT_ALLOWED}`)
  }
}

/**
 * Throws on a C1 control (U+007F to U+009F) the document does not hold inside
 * a double-quoted scalar, the one place a writer escapes it and a reader sees
 * the escape rather than the character.
 */
function refuseUnquotedC1(text: string, quoted: readonly (readonly [number, number])[]): void {
  for (const match of text.matchAll(/[\u007f-\u009f]/g)) {
    const at = match.index
    if (!quoted.some(([start, end]) => at >= start && at < end)) {
      throw new Error(`C1 control characters are not allowed outside double quotes ${NOT_ALLOWED}`)
    }
  }
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

/**
 * Throws on a string or key holding a lone UTF-16 surrogate, checked on the
 * resolved value because an escape (`"\\uD800"`) and a raw one are the same
 * defect: no Unicode text, and so nothing a UTF-8 reader could hold.
 */
function refuseLoneSurrogates(value: unknown): void {
  if (holdsLoneSurrogate(value)) {
    throw new Error(`a lone UTF-16 surrogate is not allowed ${NOT_ALLOWED}`)
  }
}

function holdsLoneSurrogate(value: unknown): boolean {
  if (typeof value === 'string') return LONE_SURROGATE.test(value)
  if (Array.isArray(value)) return value.some(holdsLoneSurrogate)
  if (value === null || typeof value !== 'object') return false
  return Object.entries(value).some(
    ([key, item]) => LONE_SURROGATE.test(key) || holdsLoneSurrogate(item),
  )
}

/**
 * YAML to a JS value, except that an integer written past 2^53 comes back as
 * the bigint it was written as instead of the neighbouring double it rounds
 * to. The rounded number cannot be told from an exact one afterwards, so it
 * would be stored as a different value than the author wrote; a bigint is
 * what `yamlSafeValueSchema` already refuses, which turns the loss into the
 * write-time refusal naming the key.
 *
 * Errors throw as `yaml`'s `parse` throws them, and so do an anchor or alias,
 * nesting past MAX_FRONTMATTER_DEPTH, and anything outside the subset above. Its warnings (an unresolved tag)
 * are not forwarded: the value is already what the document says.
 */
export function parseYamlKeepingWrittenIntegers(text: string): unknown {
  // Pinned, because a `%YAML 1.1` directive otherwise switches the reader to
  // 1.1's rules: `<<` merges one mapping into another and `yes` reads as a
  // boolean, key or value. OKF frontmatter is YAML 1.2.
  refuseUnreadableText(text)
  const doc = parseDocument(text, {
    version: '1.2',
    schema: 'core',
    merge: false,
    // A parsed pair keeps the tokens it came from; the explicit-key marker
    // is in them and nowhere else.
    keepSourceTokens: true,
  })
  const [firstError] = doc.errors
  if (firstError !== undefined) throw firstError
  const quoted: [number, number][] = []
  visit(doc, (_key, node, path) => {
    refuseAnchor(node)
    refuseTag(node)
    refuseDeepNesting(node, path)
    refuseUnsupportedKeys(text, node, path[path.length - 1])
    if (node instanceof Scalar && node.type === Scalar.QUOTE_DOUBLE && node.range != null) {
      quoted.push([node.range[0], node.range[1]])
    }
    if (!isScalar(node) || typeof node.value !== 'number') return
    if (!Number.isInteger(node.value) || Number.isSafeInteger(node.value)) return
    const written =
      typeof node.source === 'string' ? writtenInteger(node.source, node.value) : undefined
    if (written !== undefined) node.value = written
  })
  refuseUnquotedC1(text, quoted)
  const value: unknown = doc.toJS()
  refuseLoneSurrogates(value)
  return value
}
