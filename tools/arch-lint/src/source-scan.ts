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
import { join, sep } from 'node:path'

/** Every `.ts`/`.tsx` under `dir`, skipping `node_modules` and `dist`. */
export function walkSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue
      walkSourceFiles(full, out)
    } else if (/\.(ts|tsx)$/.test(entry)) out.push(full)
  }
  return out
}

/** A test file, or a helper only tests import. */
export function isTestPath(path: string): boolean {
  return /\.(test|spec)\.tsx?$/.test(path) || path.split(sep).includes('test-utils')
}

/**
 * Comments removed and string bodies blanked, so prose naming a thing is not
 * read as doing it — and a `//` inside a string does not swallow the code
 * after it.
 *
 * One pass with a state machine rather than regexes, because a regex cannot
 * tell `"//"` from a comment or `// don't` from a string, and both mistakes
 * were measured.
 *
 * A string whose body is a single identifier is KEPT, because it may be a
 * quoted object key (`'resolveAlias': …`) and a scan looking for keys has to
 * still see it. Anything longer is prose.
 *
 * Telling a regex literal from division needs the previous token; the
 * standard heuristic is enough here — a `/` opens a regex when the last
 * meaningful character was an operator, an opening bracket, or nothing.
 */
const REGEX_MAY_FOLLOW: ReadonlySet<string> = new Set([
  '',
  '(',
  ',',
  '=',
  ':',
  '[',
  '!',
  '&',
  '|',
  '?',
  '{',
  '}',
  ';',
  '+',
  '-',
  '*',
  '%',
  '<',
  '>',
  '~',
  '^',
])

/** Past the end of a `//` comment — its own newline is left for the caller. */
function skipLineComment(source: string, from: number): number {
  let i = from
  while (i < source.length && source[i] !== '\n') i += 1
  return i
}

/** Past a block comment's terminator, or to the end when it is unterminated. */
function skipBlockComment(source: string, from: number): number {
  const end = source.indexOf('*/', from + 2)
  return end === -1 ? source.length : end + 2
}

/**
 * Past a regex literal's closing delimiter.
 *
 * A closing bracket only closes a character class that an opening one began,
 * so a slash INSIDE a class does not end the literal. A newline ends the
 * scan because a regex cannot span lines, and treating an unterminated one
 * as running to EOF would swallow the rest of the file.
 */
function skipRegexLiteral(source: string, from: number): number {
  let i = from + 1
  let inClass = false
  while (i < source.length) {
    const r = source[i] as string
    if (r === '\\') {
      i += 2
      continue
    }
    if (r === '[') inClass = true
    else if (r === ']') inClass = false
    else if (r === '/' && !inClass) break
    else if (r === '\n') break
    i += 1
  }
  return i + 1
}

/**
 * A string or template literal, replaced by its own quotes plus its body
 * ONLY when the body is a bare identifier.
 *
 * Keeping identifier-shaped bodies is what lets a scan see `import x from
 * 'node:fs'`-style specifiers and property keys while still erasing prose,
 * which is where a word this tool searches for would otherwise hide.
 */
function readStringLiteral(
  source: string,
  from: number,
  quote: string,
): { next: number; text: string } {
  const start = from + 1
  let i = start
  while (i < source.length && source[i] !== quote) {
    if (source[i] === '\\') i += 1
    i += 1
  }
  const body = source.slice(start, i)
  return {
    next: i + 1,
    text: quote + (/^[A-Za-z_$][\w$]*$/.test(body) ? body : '') + quote,
  }
}

export function stripCommentsAndStrings(source: string): string {
  let out = ''
  let i = 0
  let lastMeaningful = ''
  while (i < source.length) {
    const ch = source[i] as string
    const next = source[i + 1]
    if (ch === '/' && next === '/') {
      i = skipLineComment(source, i)
      continue
    }
    if (ch === '/' && next === '*') {
      i = skipBlockComment(source, i)
      continue
    }
    if (ch === '/' && REGEX_MAY_FOLLOW.has(lastMeaningful)) {
      i = skipRegexLiteral(source, i)
      lastMeaningful = ')'
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const literal = readStringLiteral(source, i, ch)
      out += literal.text
      i = literal.next
      lastMeaningful = ch
      continue
    }
    out += ch
    if (!/\s/.test(ch)) lastMeaningful = ch
    i += 1
  }
  return out
}
