import { rustCode } from './rust-source.js'

/** One `#[expect(...)]` (or inner `#![expect(...)]`) attribute in a Rust file. */
export interface ExpectSite {
  /** The lints it expects, as written (`clippy::cast_precision_loss`). */
  readonly lints: readonly string[]
  /** The `reason = "..."` text, `undefined` when the attribute has none. */
  readonly reason: string | undefined
  /** One-based line of the attribute. */
  readonly line: number
}

const OPEN = /#!?\[\s*expect\s*\(/g
const LINT = /[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)+|[A-Za-z_][A-Za-z0-9_]*/g

/** The offset one past the `)` closing the `(` before `from`, in text with literals blanked. */
function closeOf(code: string, from: number): number {
  let depth = 1
  for (let i = from; i < code.length; i++) {
    if (code[i] === '(') depth += 1
    else if (code[i] === ')' && --depth === 0) return i + 1
  }
  return code.length
}

/**
 * Every `expect` attribute in `text`, read from code with comments and
 * literals blanked so one named inside a doc comment or a string is not
 * counted, while the reason is read back from the same offsets in the
 * original.
 */
export function expectSites(text: string): ExpectSite[] {
  const code = rustCode(text)
  const sites: ExpectSite[] = []
  for (const open of code.matchAll(OPEN)) {
    const bodyStart = open.index + open[0].length
    const body = code.slice(bodyStart, closeOf(code, bodyStart) - 1)
    const original = text.slice(bodyStart, bodyStart + body.length)
    const reasonAt = body.search(/\breason\s*=/)
    const lintPart = reasonAt === -1 ? body : body.slice(0, reasonAt)
    const reason = /\breason\s*=\s*"((?:[^"\\]|\\.)*)"/s.exec(original)?.[1]
    sites.push({
      lints: lintPart.match(LINT) ?? [],
      reason,
      line: text.slice(0, open.index).split('\n').length,
    })
  }
  return sites
}
