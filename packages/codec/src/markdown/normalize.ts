import type { MdastRoot } from '@kamiazya/whiteboard-model/mdast'

/**
 * Markdown text cannot distinguish "explicitly null" from "absent" for any
 * optional field (title/alt/label/lang/meta), and a real remark
 * stringify->parse round trip always resolves `list.ordered`/`.spread` and
 * `listItem.checked` to concrete values rather than leaving them `undefined`
 * (mdast-util-from-markdown infers them from the marker/blank-line syntax it
 * sees). `normalizeMdast` canonicalizes exactly those representational
 * degrees of freedom so `normalizeMdast(parse(stringify(x))) ===
 * normalizeMdast(x)` compares semantic content, not incidental encoding
 * choices markdown has no room to preserve.
 */

/**
 * The recursive walk below touches heterogeneous field values (child node
 * arrays, but also primitive fields like a table's `align` entries) whose
 * shape isn't known until runtime, so it operates on `unknown` and narrows
 * with this guard rather than trusting an untyped `any`.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * remark-parse merges any run of adjacent plain-text tokens into a single
 * `text` node — a tree with two consecutive `text` siblings is not
 * representable after a real parse, so this canonicalizes it up front
 * rather than treating the merge as information loss.
 */
function mergeAdjacentText(children: unknown[]): unknown[] {
  const merged: unknown[] = []
  for (const child of children) {
    const previous = merged[merged.length - 1]
    if (
      isPlainObject(previous) &&
      previous.type === 'text' &&
      isPlainObject(child) &&
      child.type === 'text'
    ) {
      merged[merged.length - 1] = { type: 'text', value: `${previous.value}${child.value}` }
    } else {
      merged.push(child)
    }
  }
  return merged
}

/**
 * `meta`/`lang` (fence info string) and `title`/`alt`/`label` (link and
 * image attributes) all render as nothing when empty — an empty string
 * there is textually identical to the field being absent altogether.
 */
const RENDERS_EMPTY_AS_ABSENT = new Set(['meta', 'lang', 'title', 'alt', 'label'])

function normalizeField(key: string, value: unknown): unknown {
  if (Array.isArray(value)) return mergeAdjacentText(value.map(normalizeNode))
  if (RENDERS_EMPTY_AS_ABSENT.has(key) && typeof value === 'string') {
    // The fence info string's leading/trailing whitespace around `meta`
    // (and around `lang` itself) is not preserved by mdast-util-to-markdown
    // — trim before comparing rather than only special-casing "all
    // whitespace".
    const trimmed = value.trim()
    return trimmed === '' ? undefined : trimmed
  }
  return value === null ? undefined : value
}

const isBlank = (value: unknown): boolean =>
  value === null || value === undefined || String(value).trim() === ''

/** What a node's TYPE canonicalises, beyond what each field does alone. */
function canonicalizeByType(
  node: Record<string, unknown>,
  normalized: Record<string, unknown>,
): void {
  if (node.type === 'list') {
    normalized.ordered = Boolean(node.ordered)
    normalized.spread = Boolean(node.spread)
  }
  if (node.type === 'listItem') {
    normalized.checked = node.checked ?? null
    normalized.spread = Boolean(node.spread)
  }
  // A fence's info string is `lang` followed by ` meta` — with no `lang`,
  // `meta` has nowhere to render (it would be parsed back as `lang` itself),
  // so mdast-util-to-markdown drops it. Canonicalize that combination up
  // front rather than only trimming meta in isolation.
  if ((node.type === 'code' || node.type === 'math') && isBlank(node.lang)) {
    normalized.meta = undefined
  }
}

function normalizeNode(node: unknown): unknown {
  if (!isPlainObject(node)) return node
  const normalized: Record<string, unknown> = { type: node.type }
  for (const [key, value] of Object.entries(node)) {
    if (key !== 'type') normalized[key] = normalizeField(key, value)
  }
  canonicalizeByType(node, normalized)
  return normalized
}

export function normalizeMdast(root: MdastRoot): MdastRoot {
  return normalizeNode(root) as MdastRoot
}
