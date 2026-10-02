/**
 * Source text with every comment blanked, for a test that scans code with a
 * pattern and must not read prose as a call site.
 *
 * A token walk rather than `replace(/\/\/.*$/gm, '')`: a regex cannot tell
 * the `//` that starts a comment from the one inside `'https://a.example'`
 * or `import.meta.glob('./**\/*.ts')`, so it deletes the rest of the line
 * (`localStorage.setItem` after such a string went unseen) or mangles the
 * glob. Strings, template literals (interpolations nest) and regex literals
 * are copied through untouched.
 *
 * Comments become spaces and keep their newlines, so offsets and line
 * numbers of what remains are the original's.
 *
 * Mirrored byte-for-byte in `packages/mcp-server/src/shared/test-utils/`:
 * neither package may import the other's test code and `tools/arch-lint`
 * holds the only TypeScript compiler API, so the copies are held identical,
 * and checked against that API, by arch-lint's
 * `strip-comments-one-place.test.ts`.
 */

// A `/` after one of these opens a regex literal; after anything else
// (an identifier, a number, a closing bracket) it divides.
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

// An identifier that ends in one of these is an operator, so a `/` after it
// opens a regex: `return /x/.test(s)`.
const REGEX_MAY_FOLLOW_WORD: ReadonlySet<string> = new Set([
  'return',
  'typeof',
  'case',
  'in',
  'of',
  'delete',
  'void',
  'throw',
  'new',
  'else',
  'do',
  'yield',
  'await',
])

const IDENTIFIER_CHAR = /[\w$]/

function blank(text: string): string {
  return text.replace(/[^\n]/g, ' ')
}

/** Index just past the comment that starts at `from`; a line comment keeps its newline. */
function endOfComment(source: string, from: number): number {
  if (source[from + 1] === '*') {
    const close = source.indexOf('*/', from + 2)
    return close === -1 ? source.length : close + 2
  }
  const newline = source.indexOf('\n', from)
  return newline === -1 ? source.length : newline
}

/** Index just past the quote that closes the string opened at `from`. */
function endOfString(source: string, from: number): number {
  const quote = source[from]
  let i = from + 1
  while (i < source.length && source[i] !== quote && source[i] !== '\n') {
    i += source[i] === '\\' ? 2 : 1
  }
  return Math.min(i + 1, source.length)
}

/** Index just past a regex literal; a character class may hold an unescaped `/`. */
function endOfRegex(source: string, from: number): number {
  let i = from + 1
  let inClass = false
  while (i < source.length && source[i] !== '\n') {
    const ch = source[i]
    if (ch === '\\') i += 1
    else if (ch === '[') inClass = true
    else if (ch === ']') inClass = false
    else if (ch === '/' && !inClass) return i + 1
    i += 1
  }
  return Math.min(i, source.length)
}

/**
 * Where a template's literal text stops: just past the closing backtick, or
 * just past the `${` that opens an interpolation.
 */
function endOfTemplateText(source: string, from: number): { end: number; interpolates: boolean } {
  let i = from
  while (i < source.length) {
    if (source[i] === '\\') i += 2
    else if (source[i] === '`') return { end: i + 1, interpolates: false }
    else if (source[i] === '$' && source[i + 1] === '{') return { end: i + 2, interpolates: true }
    else i += 1
  }
  return { end: source.length, interpolates: false }
}

/** Where a walk over `source` has got to, and what the last token was. */
interface Walk {
  readonly source: string
  out: string
  at: number
  // The last significant character and the identifier it ended, which decide
  // whether a `/` divides or opens a regex.
  previous: string
  word: string
  depth: number
  // The brace depth each open `${` returns to when its `}` arrives.
  readonly interpolations: number[]
}

/** Copies `source` from the walk's position up to `end`, unchanged. */
function copyTo(walk: Walk, end: number): void {
  walk.out += walk.source.slice(walk.at, end)
  walk.at = end
}

function finishToken(walk: Walk, previous: string): void {
  walk.previous = previous
  walk.word = ''
}

/** Copies template text from the walk's position to the end of the template or its next `${`. */
function copyTemplateText(walk: Walk): void {
  const { end, interpolates } = endOfTemplateText(walk.source, walk.at)
  copyTo(walk, end)
  finishToken(walk, interpolates ? '' : '`')
  if (interpolates) walk.interpolations.push(walk.depth)
}

/** Consumes the comment, regex, string or template opener at the walk's position, if there is one. */
function consumeToken(walk: Walk): boolean {
  const { source, at } = walk
  const ch = source[at]
  const next = source[at + 1]
  if (ch === '/' && (next === '/' || next === '*')) {
    const end = endOfComment(source, at)
    walk.out += blank(source.slice(at, end))
    walk.at = end
    return true
  }
  if (ch === '/' && (REGEX_MAY_FOLLOW.has(walk.previous) || REGEX_MAY_FOLLOW_WORD.has(walk.word))) {
    copyTo(walk, endOfRegex(source, at))
    finishToken(walk, ')')
    return true
  }
  if (ch === "'" || ch === '"') {
    copyTo(walk, endOfString(source, at))
    finishToken(walk, ch)
    return true
  }
  if (ch === '`') {
    copyTo(walk, at + 1)
    walk.word = ''
    copyTemplateText(walk)
    return true
  }
  return false
}

/** Consumes one character of code, tracking braces so a `}` can close a template's `${`. */
function consumeCode(walk: Walk): void {
  const ch = walk.source[walk.at] as string
  if (ch === '{') walk.depth += 1
  if (ch === '}') {
    if (walk.interpolations[walk.interpolations.length - 1] === walk.depth) {
      walk.interpolations.pop()
      copyTo(walk, walk.at + 1)
      walk.word = ''
      copyTemplateText(walk)
      return
    }
    walk.depth -= 1
  }
  copyTo(walk, walk.at + 1)
  if (IDENTIFIER_CHAR.test(ch)) {
    walk.word = IDENTIFIER_CHAR.test(walk.previous) ? walk.word + ch : ch
    walk.previous = ch
  } else if (!/\s/.test(ch)) {
    finishToken(walk, ch)
  }
}

export function stripComments(source: string): string {
  const walk: Walk = {
    source,
    out: '',
    at: 0,
    previous: '',
    word: '',
    depth: 0,
    interpolations: [],
  }
  while (walk.at < source.length) {
    if (!consumeToken(walk)) consumeCode(walk)
  }
  return walk.out
}
