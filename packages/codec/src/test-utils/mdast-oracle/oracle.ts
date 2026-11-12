import { mdastRootSchema } from '@kamiazya/whiteboard-model/mdast'
import { parseMarkdownBody } from '../../markdown/pipeline.js'
import { toWellFormed } from '../frontmatter-oracle/oracle.js'
import { generated, type Input, PAST_BOUND_PREFIX, RANDOM_COUNT, SEED } from './corpus.js'

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
 * A body is made well-formed first, as wasm-bindgen's string passing does it,
 * because JSON cannot spell a lone surrogate and a Rust `&str` cannot hold one.
 */
export type Case = Input & { h: string; m?: unknown }

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
const canonical = (tree: unknown): string => JSON.stringify(sortKeys(tree))

const MASK = (1n << 64n) - 1n
const PRIME = 0x100000001b3n

function fnv64(text: string): string {
  let h = 0xcbf29ce484222325n
  for (const byte of new TextEncoder().encode(text)) h = ((h ^ BigInt(byte)) * PRIME) & MASK
  return h.toString(16).padStart(16, '0')
}

export function answer(body: string): { h: string; tree: unknown } {
  const tree = mdastRootSchema.parse(parseMarkdownBody(toWellFormed(body)))
  return { h: fnv64(canonical(tree)), tree: JSON.parse(canonical(tree)) }
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

export function record(frozen: Input[]): (Meta | Case)[] {
  const answered = (input: Input): Case => {
    const t = toWellFormed(input.t)
    const { h, tree } = answer(t)
    return withTree(input.i) ? { i: input.i, t, h, m: tree } : { i: input.i, t, h }
  }
  return [meta(), ...frozen.map(answered), ...generated().map(answered)]
}
