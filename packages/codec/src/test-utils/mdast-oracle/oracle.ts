import { mdastRootSchema } from '@kamiazya/whiteboard-model/mdast'
import { parseMarkdownBlockLines, parseMarkdownBody } from '../../markdown/pipeline.js'
import { toWellFormed } from '../frontmatter-oracle/oracle.js'
import { type Input, PAST_BOUND_PREFIX, RANDOM_COUNT, SEED } from './corpus.js'

/**
 * The answers recorded from `parseMarkdownBody` that the Rust parser is held
 * to (`crates/core/markdown/tests/mdast_oracle.rs`).
 *
 * What is compared is the MODEL tree (`mdastRootSchema`'s output, which is
 * what canvas-render and the references pass receive), as canonical JSON: keys
 * sorted, absent and `undefined` the same, no positions (the model has none).
 * A case holds the FNV-1a 64 digest of that text; the spec examples and the
 * hand-written dialect cases hold the tree too, so a mismatch there reads as
 * a difference rather than as two hashes.
 *
 * A case also holds `l`, what `parseMarkdownBlockLines` answers for it — the
 * start line of each top-level block — which the Rust core's layout answer
 * carries (`crates/core/codec/tests/markdown_block_lines_oracle.rs`).
 *
 * A case also holds `x`, the one-line plain text the web app's rail row showed
 * for it (`commentExcerpt`, as the TypeScript walked the tree), which the Rust
 * core's `markdown_excerpt` answers
 * (`crates/core/codec/tests/markdown_excerpt_oracle.rs`).
 *
 * A body is made well-formed first, as wasm-bindgen's string passing does it,
 * because JSON cannot spell a lone surrogate and a Rust `&str` cannot hold one.
 */
export type Case = Input & { h: string; l: number[]; x: string; m?: unknown }

/** Sets whose trees are recorded in full: small, and read by a person. */
export const withTree = (id: string): boolean => /^(cm#|gfm#|d\d)/.test(id)

const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return Object.fromEntries(entries.map(([k, v]) => [k, sortKeys(v)]))
  }
  return value
}

/** The canonical text of a model tree. */
export const canonical = (tree: unknown): string => JSON.stringify(sortKeys(tree))

const MASK = (1n << 64n) - 1n
const PRIME = 0x100000001b3n

export function fnv64(text: string): string {
  let h = 0xcbf29ce484222325n
  for (const byte of new TextEncoder().encode(text)) h = ((h ^ BigInt(byte)) * PRIME) & MASK
  return h.toString(16).padStart(16, '0')
}

const BLOCK_TYPES = new Set([
  'paragraph',
  'heading',
  'listItem',
  'blockquote',
  'code',
  'table',
  'tableRow',
  'thematicBreak',
])

type Walked = { type?: string; value?: unknown; alt?: unknown; children?: unknown[] }

function walkExcerpt(node: unknown, out: string[]): void {
  if (node === null || typeof node !== 'object') return
  const { type, value, alt, children } = node as Walked
  if (typeof value === 'string') out.push(value)
  else if (type === 'image' && typeof alt === 'string' && alt !== '') out.push(alt)
  if (Array.isArray(children)) for (const child of children) walkExcerpt(child, out)
  if (type !== undefined && BLOCK_TYPES.has(type)) out.push(' ')
}

/** What the rail row's excerpt was: the parsed tree's values, a space after each block, collapsed. */
function excerptOf(root: unknown): string {
  const parts: string[] = []
  walkExcerpt(root, parts)
  return parts.join('').replace(/\s+/g, ' ').trim()
}

export function answer(body: string): { h: string; l: number[]; x: string; tree: unknown } {
  const text = toWellFormed(body)
  const tree = mdastRootSchema.parse(parseMarkdownBody(text))
  return {
    h: fnv64(canonical(tree)),
    l: parseMarkdownBlockLines(text),
    x: excerptOf(tree),
    tree: JSON.parse(canonical(tree)),
  }
}

export type Meta = { kind: 'meta'; seed: number; random: number; pastBound: string }

export const meta = (): Meta => ({
  kind: 'meta',
  seed: SEED,
  random: RANDOM_COUNT,
  pastBound: PAST_BOUND_PREFIX,
})

/** Recorded inputs that are data rather than generated: repository text and the spec examples. */
export const isFrozen = (id: string): boolean => /^(md:|okf|cv|cm#|gfm#)/.test(id)
