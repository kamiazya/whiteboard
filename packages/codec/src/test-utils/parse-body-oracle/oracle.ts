import { parseMarkdownBody } from '../../markdown/pipeline.js'
import { resolveReferences } from '../../references/resolve.js'
import { toWellFormed } from '../frontmatter-oracle/oracle.js'
import { canonical, fnv64 } from '../mdast-oracle/oracle.js'
import { ALIASES, type Input, inputs, RANDOM_COUNT, SEED } from './corpus.js'

/**
 * The answers recorded from `resolveReferences(parseMarkdownBody(t), …)` that
 * `whiteboard-codec`'s `parse_markdown_body` and `resolve_references` are held
 * to (`crates/core/codec/tests/parse_body_oracle.rs`). Each case is answered
 * twice: through `ALIASES`, and with no resolver, where only a ULID resolves.
 * What is compared is the canonical model tree (`mdast-oracle`'s): a hand-written
 * case keeps both trees, a generated one their FNV-1a 64 digests.
 */
export type Case = Input & { h: string; n: string; m?: unknown; u?: unknown }

export type Meta = {
  kind: 'meta'
  seed: number
  random: number
  aliases: Readonly<Record<string, string>>
}

const meta = (): Meta => ({
  kind: 'meta',
  seed: SEED,
  random: RANDOM_COUNT,
  aliases: ALIASES,
})

const resolveAlias = (alias: string): string | null =>
  Object.hasOwn(ALIASES, alias) ? (ALIASES[alias] ?? null) : null

const tree = (body: string, resolver?: (alias: string) => string | null): unknown =>
  JSON.parse(canonical(resolveReferences(parseMarkdownBody(body), resolver)))

/**
 * The hand-written cases keep their trees, read by a person. The generated
 * ones and the deep ones keep digests only: a tree nested 64 deep is past the
 * 128 levels a JSON reader on the Rust side follows.
 */
const withTree = (id: string): boolean => /^[gd]\d/.test(id)

function answer(input: Input): Case {
  const t = toWellFormed(input.t)
  const m = tree(t, resolveAlias)
  const u = tree(t)
  const digests = { h: fnv64(JSON.stringify(m)), n: fnv64(JSON.stringify(u)) }
  return withTree(input.i) ? { i: input.i, t, ...digests, m, u } : { i: input.i, t, ...digests }
}

export const record = (): (Meta | Case)[] => [meta(), ...inputs().map(answer)]
