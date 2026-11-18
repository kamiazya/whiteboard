import { type AliasResolver, scanReferences } from '@kamiazya/whiteboard-codec'
import { type MdastRoot, mdastRootSchema } from '@kamiazya/whiteboard-model/mdast'

/**
 * What a markdown text means, as the Rust core's parser reads it: the one
 * parser left, so the oracle the editor's property tests hold the editor's own
 * reading to. The core is an `oracle-surface` export of the wasm artifact
 * (crates/bindings/wasm/src/markdown_model.rs), installed per test realm by
 * `vitest.markdown-model.setup.ts` because loading it reads a file, which the
 * browser app's source may not do. A realm that installed none fails its
 * first read by name.
 */
type MarkdownModel = (text: string, aliases: string) => string

/** What the wasm string crossing makes of a lone surrogate: a Rust `&str` cannot hold one. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g

let installed: MarkdownModel | undefined

export function installMarkdownModel(answer: MarkdownModel): void {
  installed = answer
}

/**
 * The model tree of `text`. Given a `resolver`, its `[[…]]` references are
 * resolved the way a reader resolves them, and left as text where it answers
 * `null`; `() => null` resolves a `[[<id>]]` alone, and no resolver leaves
 * every reference as text. The core takes the answers as a table, so the
 * resolver is asked once for each target the text names. Throws for a text
 * past one of the parser's bounds, which these inputs are not.
 */
export function parseMarkdownModel(text: string, resolver?: AliasResolver): MdastRoot {
  if (installed === undefined) {
    throw new Error('no markdown model installed; this test belongs to the web-rust project')
  }
  const body = text.replace(LONE_SURROGATE, '\ufffd')
  const answer: unknown = JSON.parse(installed(body, aliasTable(body, resolver)))
  if (!Array.isArray(answer) || answer[0] !== 'ok') {
    throw new Error(`the core refused the markdown body: ${JSON.stringify(answer)}`)
  }
  return mdastRootSchema.parse(answer[1])
}

/** The core's alias table: what `resolver` answers for each target `body` names, or '' for no resolution. */
function aliasTable(body: string, resolver: AliasResolver | undefined): string {
  if (resolver === undefined) return ''
  const table: Record<string, string> = {}
  for (const { target } of scanReferences(body)) {
    const id = resolver(target)
    if (id !== null) table[target] = id
  }
  return JSON.stringify(table)
}
