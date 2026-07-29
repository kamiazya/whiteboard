import type { MdastRoot } from '@kamiazya/whiteboard-canvas-model/mdast'

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

function normalizeNode(node: unknown): unknown {
  if (!isPlainObject(node)) return node

  const normalized: Record<string, unknown> = { type: node.type }

  for (const [key, value] of Object.entries(node)) {
    if (key === 'type') continue
    if (Array.isArray(value)) {
      normalized[key] = mergeAdjacentText(value.map(normalizeNode))
      continue
    }
    // A code/math fence's `meta` is free text typed after the language on
    // the opening fence line — an empty string there is textually identical
    // to no meta at all, so both collapse to the same canonical value.
    // `meta`/`lang` (fence info string) and `title`/`alt`/`label` (link and
    // image attributes) all render as nothing when empty — an empty string
    // there is textually identical to the field being absent altogether.
    if (
      (key === 'meta' || key === 'lang' || key === 'title' || key === 'alt' || key === 'label') &&
      typeof value === 'string'
    ) {
      // The fence info string's leading/trailing whitespace around `meta`
      // (and around `lang` itself) is not preserved by mdast-util-to-markdown
      // — trim before comparing rather than only special-casing "all
      // whitespace".
      const trimmed = value.trim()
      normalized[key] = trimmed === '' ? undefined : trimmed
      continue
    }
    normalized[key] = value === null ? undefined : value
  }

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
  if (
    (node.type === 'code' || node.type === 'math') &&
    (node.lang === null || node.lang === undefined || String(node.lang).trim() === '')
  ) {
    normalized.meta = undefined
  }

  return normalized
}

export function normalizeMdast(root: MdastRoot): MdastRoot {
  return normalizeNode(root) as MdastRoot
}
