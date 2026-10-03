/**
 * What an arch-lint source scan needs before it can match anything: the file
 * walk, the test-file test, and a stripper that leaves only code.
 *
 * Shared because the three scans that read source want the same JUDGEMENT —
 * "what in this file is real code" — not merely because all three read files.
 * That distinction is `.claude/rules/coverage-ledger.md`'s, and a glob with a
 * parameter would not have earned an extraction.
 *
 * What earned it: `stripComments` was copied between scans, and one copy had
 * a bug the other did not. A `/` was only ever a comment or division here, so
 * a REGEX LITERAL containing a quote — `bearer-token.ts`'s `/[\s,"]/` is the
 * real one — opened a "string" that ran to the next quote far below and
 * blanked the rest of the file. Measured against the live seams scan: a seam
 * defined after such a regex was invisible to it. The failure is in the
 * dangerous direction, since the scan then reports clean.
 */
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import ts from '@typescript/typescript6'

/**
 * Every `.ts`/`.tsx` under `dir`, skipping `node_modules`, `dist` and `tmp`.
 * `tmp` holds git-ignored scratch (a Stryker sandbox is a full copy of a
 * package's source), and no tracked source lives in a directory of that name.
 */
export function walkSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist' || entry === 'tmp') continue
      walkSourceFiles(full, out)
    } else if (/\.(ts|tsx)$/.test(entry)) out.push(full)
  }
  return out
}

/**
 * What a path IS to the build, so "shipped or not" is answered once.
 *
 * - `test`: a `.test`/`.spec` file.
 * - `test-support`: a helper only tests import — a `test-utils`/`testing`/
 *   `__tests__`/`fixtures`/`test-config` directory, a `-test-utils` file, or a
 *   `_test-*` basename beside the code it seeds.
 * - `harness`: runs a BUILT artefact (`.smoke-impl`, `.distribution-impl`,
 *   `.stress`, an `e2e` directory), never part of one.
 * - `bench`: a `.bench` file.
 * - `docs-snapshot`: the doc-screenshot browser tests under `docs-snapshots`.
 *
 * Everything else is `shipped`. Separators are normalised, so an absolute or a
 * repo-relative path of either flavour classifies the same.
 */
export type PathCategory =
  | 'shipped'
  | 'test'
  | 'test-support'
  | 'harness'
  | 'bench'
  | 'docs-snapshot'

export function classifyPath(path: string): PathCategory {
  const p = path.replaceAll('\\', '/')
  const base = p.slice(p.lastIndexOf('/') + 1)
  if (/\.(test|spec)\.[a-z]+$/.test(base)) return 'test'
  if (/\.bench\.[a-z]+$/.test(base)) return 'bench'
  if (/\.(smoke-impl|distribution-impl|stress)\./.test(base) || /(^|\/)e2e\//.test(p)) {
    return 'harness'
  }
  if (/(^|\/)docs-snapshots\//.test(p)) return 'docs-snapshot'
  if (
    /(^|\/)(test-utils|testing|__tests__|fixtures|test-config)\//.test(p) ||
    /-test-utils\.[a-z]+$/.test(base) ||
    base.startsWith('_test-')
  ) {
    return 'test-support'
  }
  return 'shipped'
}

/** Every category but `shipped` is code that never reaches a user. */
export function isShippedPath(path: string): boolean {
  return classifyPath(path) === 'shipped'
}

/**
 * A test, or a helper only tests import (`test` and `test-support`). Benches,
 * harnesses and doc snapshots are NOT here: a guard that must skip them too
 * asks `isShippedPath`.
 */
export function isTestPath(path: string): boolean {
  const category = classifyPath(path)
  return category === 'test' || category === 'test-support'
}

function parse(source: string, fileName: string, kind: ts.ScriptKind): ts.SourceFile {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false, kind)
}

/** The parser's own syntax-error count; `parseDiagnostics` is not in the public typings. */
function syntaxErrors(file: ts.SourceFile): number {
  return (
    (file as unknown as { parseDiagnostics?: readonly unknown[] }).parseDiagnostics?.length ?? 0
  )
}

function parseSource(source: string, fileName: string | undefined): ts.SourceFile {
  if (fileName !== undefined) {
    return parse(source, fileName, fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  }
  const plain = parse(source, 'source.ts', ts.ScriptKind.TS)
  if (syntaxErrors(plain) === 0) return plain
  const jsx = parse(source, 'source.tsx', ts.ScriptKind.TSX)
  return syntaxErrors(jsx) < syntaxErrors(plain) ? jsx : plain
}

/** One source range replaced by `text`. */
type Edit = { start: number; end: number; text: string }

const IDENTIFIER_BODY = /^[A-Za-z_$][\w$]*$/

function quoted(file: ts.SourceFile, node: ts.StringLiteralLike, quote: string): string {
  const raw = file.text.slice(node.getStart(file) + 1, node.end - 1)
  return quote + (IDENTIFIER_BODY.test(raw) ? raw : '') + quote
}

function literalEdit(file: ts.SourceFile, node: ts.Node): Edit | undefined {
  const start = node.getStart(file)
  const edit = (text: string): Edit => ({ start, end: node.end, text })
  switch (node.kind) {
    case ts.SyntaxKind.StringLiteral:
      return edit(quoted(file, node as ts.StringLiteral, file.text[start] as string))
    case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
      return edit(quoted(file, node as ts.NoSubstitutionTemplateLiteral, '`'))
    case ts.SyntaxKind.TemplateHead:
      return edit('`${')
    case ts.SyntaxKind.TemplateMiddle:
      return edit('}${')
    case ts.SyntaxKind.TemplateTail:
      return edit('}`')
    case ts.SyntaxKind.RegularExpressionLiteral:
      return edit('')
    default:
      return undefined
  }
}

/**
 * Comments removed, string bodies blanked, and regex literals dropped, so
 * prose naming a thing is not read as doing it — and a `//` inside a string
 * does not swallow the code after it.
 *
 * Read off the TypeScript parser, never a character scan: a text scanner
 * cannot know that the code inside a template's `${…}` is code (a call there
 * was invisible to every guard), that a template nested in a substitution
 * closes its own backtick, that `</A>` ends a JSX element rather than
 * starting a regex, or that a `/` after `)` can open one. Each of those was
 * measured against the real tree; `source-scan.test.ts` pins them.
 *
 * A string whose body is a single identifier is KEPT, because it may be a
 * quoted object key (`'resolveAlias': …`) and a scan looking for keys has to
 * still see it. Anything longer is prose. A template's literal text is
 * dropped but its `${` and `}` stay, so the substitutions read as the code
 * they are.
 *
 * `fileName` picks the grammar: `.tsx` reads `<T>x` as JSX, `.ts` reads it as
 * a type assertion, and a wrong choice garbles the tokens. Without one, the
 * text is read as whichever grammar reports fewer syntax errors, `.ts` on a
 * tie.
 */
/**
 * The comments in the stretches of code BETWEEN the carved-out ranges.
 *
 * A bare scanner is trustworthy there and only there: what it cannot know is
 * whether a quote opens a string, a backtick a template or a slash a regex,
 * and every token that could be read either way is already a carved range. So
 * the parser decides what is a literal and the scanner reads the rest, which
 * costs a lex of the gaps instead of a node for every token.
 */
function commentsBetween(text: string, carved: readonly Edit[]): Edit[] {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false)
  const found: Edit[] = []
  const scanGap = (from: number, to: number): void => {
    scanner.setText(text, from, to - from)
    for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
      if (
        kind === ts.SyntaxKind.SingleLineCommentTrivia ||
        kind === ts.SyntaxKind.MultiLineCommentTrivia
      ) {
        found.push({ start: scanner.getTokenStart(), end: scanner.getTokenEnd(), text: '' })
      }
    }
  }
  let cursor = 0
  for (const range of [...carved].sort((a, b) => a.start - b.start)) {
    scanGap(cursor, range.start)
    cursor = range.end
  }
  scanGap(cursor, text.length)
  return found
}

/**
 * A parse per file is what the parser-based strip costs, and a guard with
 * several `it`s walks the same tree once per `it`; the memo pays the parse
 * once per worker. Keyed by name and text, so an edit between calls is a
 * miss rather than a stale answer.
 */
const stripped = new Map<string, string>()

export function stripCommentsAndStrings(source: string, fileName?: string): string {
  const key = `${fileName ?? ''}\u0000${source}`
  const hit = stripped.get(key)
  if (hit !== undefined) return hit
  const result = stripUncached(source, fileName)
  stripped.set(key, result)
  return result
}

function stripUncached(source: string, fileName?: string): string {
  const file = parseSource(source, fileName)
  const edits: Edit[] = []
  // Text a scanner cannot be trusted with, and which is not rewritten: JSX
  // children are prose that may hold an apostrophe or a `//`.
  const carved: Edit[] = []
  const visit = (node: ts.Node): void => {
    const edit = literalEdit(file, node)
    if (edit !== undefined) {
      edits.push(edit)
      carved.push(edit)
    } else if (node.kind === ts.SyntaxKind.JsxText) {
      carved.push({ start: node.pos, end: node.end, text: '' })
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  edits.push(...commentsBetween(source, carved))

  let out = ''
  let cursor = 0
  for (const edit of edits.sort((a, b) => a.start - b.start)) {
    out += source.slice(cursor, edit.start) + edit.text
    cursor = edit.end
  }
  return out + source.slice(cursor)
}
