import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT, relativeToRepo, walk } from './scan-roots.js'

/**
 * What the comment and size guards need to know about Rust source, without a
 * Rust parser: where a comment is, where a literal is, and where a `fn` body
 * starts and ends.
 *
 * A lexer rather than a regex for the reason `strip-comments.ts` gives on the
 * TypeScript side: `//` inside `"https://a.example"` is not a comment, and a
 * `"` inside `r#"say "hi""#` does not end the string. What Rust adds is the
 * apostrophe, which is a char literal (`'{'`) or a lifetime (`'a`), and nested
 * block comments, which a non-nesting reading closes one `*\/` early.
 *
 * `syn` is not reachable from here (this package is TypeScript and runs no
 * cargo), and none of these guards needs a syntax tree: a comment, a literal
 * and a balanced brace are lexical facts. Macro bodies are token trees, whose
 * delimiters the language itself requires to balance, so brace matching
 * holds inside them too.
 */

/** A lexical span: `[start, end)` offsets into the text it was read from. */
type Span = readonly [number, number]

interface RustLexemes {
  readonly comments: readonly Span[]
  /** String, raw-string, byte-string and char literals, delimiters included. */
  readonly literals: readonly Span[]
}

const IDENT_CHAR = /[\p{XID_Continue}_]/u

function isIdentChar(text: string, at: number): boolean {
  const ch = text[at]
  return ch !== undefined && IDENT_CHAR.test(ch)
}

/** The end of a `/* … *\/` comment that opens at `start`, nesting counted. Unterminated runs to the end. */
function blockCommentEnd(text: string, start: number): number {
  let depth = 0
  let i = start
  while (i < text.length) {
    if (text.startsWith('/*', i)) {
      depth += 1
      i += 2
    } else if (text.startsWith('*/', i)) {
      depth -= 1
      i += 2
      if (depth === 0) return i
    } else i += 1
  }
  return text.length
}

/** The end of a `"…"` literal whose opening quote is at `quote`, escapes honoured. */
function quotedEnd(text: string, quote: number): number {
  let i = quote + 1
  while (i < text.length) {
    if (text[i] === '\\') i += 2
    else if (text[i] === '"') return i + 1
    else i += 1
  }
  return text.length
}

/**
 * A raw string opening at `at` (`r"`, `r#"`, `br##"`, `cr#"` — the prefix
 * letter already consumed): its end, or nothing when `r#` is a raw identifier
 * (`r#type`) instead.
 */
function rawStringEnd(text: string, afterR: number): number | undefined {
  let hashes = 0
  while (text[afterR + hashes] === '#') hashes += 1
  if (text[afterR + hashes] !== '"') return undefined
  const close = `"${'#'.repeat(hashes)}`
  const end = text.indexOf(close, afterR + hashes + 1)
  return end === -1 ? text.length : end + close.length
}

/**
 * A char literal opening at `quote`, or nothing when the apostrophe is a
 * lifetime or a label (`'a`, `'static`, `'outer: loop`). One code point and a
 * closing apostrophe is a char; so is any escape.
 */
function charLiteralEnd(text: string, quote: number): number | undefined {
  if (text[quote + 1] === '\\') {
    const close = text.indexOf("'", quote + 3)
    return close === -1 ? undefined : close + 1
  }
  const point = text.codePointAt(quote + 1)
  if (point === undefined || text[quote + 1] === '\n') return undefined
  const width = point > 0xffff ? 2 : 1
  return text[quote + 1 + width] === "'" ? quote + 2 + width : undefined
}

const memo = new Map<string, RustLexemes>()

/** What starts at one offset: a comment, a literal, or neither — and where to resume. */
type Lexeme = { readonly kind: 'comment' | 'literal' | 'code'; readonly end: number }

/**
 * An identifier read whole, so a prefix letter in the middle of one (`for`
 * ends in `r`) is never taken for `r"`; a raw-string or byte/C-string prefix
 * starts its literal.
 */
function identifierLexeme(text: string, at: number): Lexeme {
  let end = at
  while (isIdentChar(text, end)) end += 1
  const word = text.slice(at, end)
  const raw = /^(?:r|br|cr)$/.test(word) ? rawStringEnd(text, end) : undefined
  if (raw !== undefined) return { kind: 'literal', end: raw }
  if (/^[bc]$/.test(word) && (text[end] === '"' || text[end] === "'")) {
    const close = text[end] === '"' ? quotedEnd(text, end) : charLiteralEnd(text, end)
    return close === undefined ? { kind: 'code', end } : { kind: 'literal', end: close }
  }
  return { kind: 'code', end }
}

function lexemeAt(text: string, at: number): Lexeme {
  const ch = text[at]
  if (ch === '/' && text[at + 1] === '/') {
    const newline = text.indexOf('\n', at)
    return { kind: 'comment', end: newline === -1 ? text.length : newline }
  }
  if (ch === '/' && text[at + 1] === '*') return { kind: 'comment', end: blockCommentEnd(text, at) }
  if (ch === '"') return { kind: 'literal', end: quotedEnd(text, at) }
  if (ch === "'") {
    const end = charLiteralEnd(text, at)
    return end === undefined ? { kind: 'code', end: at + 1 } : { kind: 'literal', end }
  }
  if (isIdentChar(text, at) && !isIdentChar(text, at - 1)) return identifierLexeme(text, at)
  return { kind: 'code', end: at + 1 }
}

/** Every comment and literal in a Rust source text, in source order. */
export function rustLexemes(text: string): RustLexemes {
  const cached = memo.get(text)
  if (cached !== undefined) return cached
  const comments: Span[] = []
  const literals: Span[] = []
  let i = 0
  while (i < text.length) {
    const { kind, end } = lexemeAt(text, i)
    if (kind === 'comment') comments.push([i, end])
    else if (kind === 'literal') literals.push([i, end])
    i = end
  }
  const found = { comments, literals }
  memo.set(text, found)
  return found
}

/** Blanks every span, keeping newlines, so an offset or line number into the result is one into `text`. */
function blank(text: string, spans: readonly Span[]): string {
  let out = ''
  let cursor = 0
  for (const [start, end] of [...spans].sort((a, b) => a[0] - b[0])) {
    out += text.slice(cursor, start) + text.slice(start, end).replace(/[^\n]/g, ' ')
    cursor = end
  }
  return out + text.slice(cursor)
}

/** The text with comments AND literals blanked: what is left is code. */
export function rustCode(text: string): string {
  const { comments, literals } = rustLexemes(text)
  return blank(text, [...comments, ...literals])
}

/**
 * The comment text on each line, everything else blanked, one entry per line
 * of `text`. A line no comment touches is empty; a trailing comment keeps its
 * column. The line-based comment guards read this instead of testing a line
 * for a leading `//`, which a raw string's content can begin with too.
 */
export function rustCommentLines(text: string): string[] {
  const { comments } = rustLexemes(text)
  let out = ''
  let cursor = 0
  for (const [start, end] of comments) {
    out += text.slice(cursor, start).replace(/[^\n]/g, ' ') + text.slice(start, end)
    cursor = end
  }
  out += text.slice(cursor).replace(/[^\n]/g, ' ')
  return out.split('\n').map((line) => line.trimEnd())
}

export interface RustFunction {
  /** `<repo-relative path>#<qualified name>`, the shape the TypeScript ledger keys with. */
  readonly key: string
  readonly lines: number
}

/** The 0-based line of every offset, answered by binary search over the line starts. */
function lineIndex(text: string): (offset: number) => number {
  const starts = [0]
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) starts.push(i + 1)
  return (offset) => {
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if ((starts[mid] ?? 0) <= offset) lo = mid
      else hi = mid - 1
    }
    return lo
  }
}

/**
 * Whether the keyword at `at` starts an item: the code before it ends a
 * statement, an item, a block or an attribute, or is a modifier that may
 * precede `impl`.
 */
function atItemPosition(code: string, at: number): boolean {
  let i = at - 1
  while (i >= 0 && /\s/.test(code[i] ?? '')) i -= 1
  if (i < 0) return true
  if (/[;{}\]]/.test(code[i] ?? '')) return true
  const word = /(?:unsafe|default)$/.exec(code.slice(Math.max(0, i - 6), i + 1))
  return word !== null && !/[\w]/.test(code[i - word[0].length] ?? '')
}

/** The offset of the `}` closing the `{` at `open`, or the end of the text. */
function closingBrace(code: string, open: number): number {
  let depth = 0
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === '{') depth += 1
    else if (code[i] === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return code.length
}

/**
 * Where an item header ends: the `{` that opens its body, or the `;` that
 * says it has none (a trait method's signature). Braces and semicolons inside
 * the header's own brackets (`[u8; N]`, a const generic `{ N }`) are skipped.
 */
function headerEnd(code: string, from: number): { at: number; body: boolean } | undefined {
  let depth = 0
  for (let i = from; i < code.length; i += 1) {
    const ch = code[i]
    if (ch === '(' || ch === '[') depth += 1
    else if (ch === ')' || ch === ']') depth -= 1
    else if (depth === 0 && ch === '{') return { at: i, body: true }
    else if (depth === 0 && ch === ';') return { at: i, body: false }
  }
  return undefined
}

/** The type an `impl` header is for: `impl<T> Trait for Type<T>` and `impl Type` both answer `Type`. */
function implSubject(header: string): string {
  const withoutGenerics = header.replace(/<[^<>]*>/g, '').replace(/<[^<>]*>/g, '')
  const subject = withoutGenerics.split(/\bfor\b/).pop() ?? withoutGenerics
  const path = subject.replace(/\bwhere\b[\s\S]*$/, '').match(/[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*/g)
  return path?.at(-1)?.split('::').at(-1) ?? 'impl'
}

const ITEM = /\b(fn|mod|impl|trait)\b/g

/**
 * Every `fn` with a body, its length from the line of the `fn` keyword to the
 * line of its closing brace, the way `function-size-measure.ts` counts a
 * TypeScript function. Qualified by the `mod`, `impl` subject, `trait` and
 * `fn` items enclosing it, so `impl A { fn new }` and `impl B { fn new }` are
 * two keys; a name that still repeats takes its occurrence index (`~2`), as
 * there.
 *
 * Closures are not measured, for the reason anonymous callbacks are not on
 * the TypeScript side: their lines already count toward the named function
 * holding them. `fn(u32) -> u32`, a function-pointer TYPE, has no name and is
 * not an item.
 */
export function measureRustSource(text: string, relativePath: string): RustFunction[] {
  const code = rustCode(text)
  const lineOf = lineIndex(text)
  const found: RustFunction[] = []
  const scopes: { name: string; end: number }[] = []
  for (const match of code.matchAll(ITEM)) {
    const at = match.index
    while (scopes.length > 0 && (scopes.at(-1)?.end ?? 0) < at) scopes.pop()
    const item = itemAt(code, at, match[1] ?? '')
    if (item === undefined) continue
    const close = closingBrace(code, item.open)
    if (match[1] === 'fn') {
      const chain = [...scopes.map((scope) => scope.name), item.name].join('.')
      found.push({ key: `${relativePath}#${chain}`, lines: lineOf(close) - lineOf(at) + 1 })
    }
    scopes.push({ name: item.name, end: close })
  }
  return withOccurrenceIndex(found)
}

/**
 * The item a keyword at `at` starts, when it starts one with a body: its name
 * and the offset of the `{` opening that body.
 */
function itemAt(
  code: string,
  at: number,
  kind: string,
): { name: string; open: number } | undefined {
  // `r#fn` is a raw identifier, not the keyword.
  if (code[at - 1] === '#') return undefined
  const afterKeyword = at + kind.length
  const header = headerEnd(code, afterKeyword)
  if (header === undefined || !header.body) return undefined
  if (kind !== 'impl') {
    const name = /^\s+(?:r#)?([A-Za-z_]\w*)/.exec(code.slice(afterKeyword))?.[1]
    return name === undefined ? undefined : { name, open: header.at }
  }
  // `impl` only opens a scope at item position: `-> impl Iterator` and
  // `x: impl Fn()` are types, and their header search would run on into the
  // body of the function they sit in.
  if (!atItemPosition(code, at)) return undefined
  return { name: implSubject(code.slice(afterKeyword, header.at)), open: header.at }
}

function withOccurrenceIndex(found: readonly RustFunction[]): RustFunction[] {
  const seen = new Map<string, number>()
  for (const row of found) seen.set(row.key, (seen.get(row.key) ?? 0) + 1)
  const taken = new Map<string, number>()
  return found.map((row) => {
    if ((seen.get(row.key) ?? 0) < 2) return row
    const index = (taken.get(row.key) ?? 0) + 1
    taken.set(row.key, index)
    return { ...row, key: `${row.key}~${String(index)}` }
  })
}

/** Directory names inside `crates/` that hold no source of this repo's own. */
const CRATE_SKIPPED_DIRS: ReadonlySet<string> = new Set(['target', 'node_modules', 'tmp', '.git'])

/** The Rust workspace's tree, relative to the repo root. */
const RUST_ROOT = 'crates'

/**
 * Every `.rs` file under `crates/`, as sorted repo-relative paths, walked
 * rather than read from git so a file written and not yet committed is
 * measured the way a new `.ts` file is.
 */
export function rustSourceFiles(repoRoot: string = REPO_ROOT): string[] {
  const root = join(repoRoot, RUST_ROOT)
  if (!existsSync(root)) return []
  return walk(root, {
    include: (path) => path.endsWith('.rs'),
    skip: (_path, name) => CRATE_SKIPPED_DIRS.has(name),
  })
    .map((path) => relativeToRepo(path, repoRoot))
    .sort()
}

/** Every crate directory under `crates/` — one holding a `Cargo.toml` — repo-relative. */
export function crateDirs(repoRoot: string = REPO_ROOT): string[] {
  const found: string[] = []
  const visit = (relative: string): void => {
    const absolute = join(repoRoot, relative)
    if (existsSync(join(absolute, 'Cargo.toml'))) found.push(relative)
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (entry.isDirectory() && !CRATE_SKIPPED_DIRS.has(entry.name) && entry.name !== 'src') {
        visit(`${relative}/${entry.name}`)
      }
    }
  }
  if (existsSync(join(repoRoot, RUST_ROOT))) visit(RUST_ROOT)
  return found.sort()
}

const LEADING_COMMENT_MARKER = /^\s*(?:\/\/|\*|\/\*)/

/**
 * The comment text on each line of a source file, for the line-based comment
 * guards: a Rust file through the lexer above, anything else by the leading
 * `//`, `*` or `/*` those guards have always tested a line for. A line with no
 * comment on it is empty, so a judgement over a non-empty entry is a judgement
 * over a comment.
 */
export function commentLinesOf(path: string, text: string): string[] {
  if (path.endsWith('.rs')) return rustCommentLines(text)
  return text.split('\n').map((line) => (LEADING_COMMENT_MARKER.test(line) ? line : ''))
}
