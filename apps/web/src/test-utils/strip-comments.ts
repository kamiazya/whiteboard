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

export function stripComments(source: string): string {
  let out = ''
  let i = 0
  let previous = ''
  let word = ''
  let depth = 0
  // The brace depth each open `${` returns to when its `}` arrives.
  const interpolations: number[] = []

  const copyTemplateText = (from: number): void => {
    const { end, interpolates } = endOfTemplateText(source, from)
    out += source.slice(from, end)
    i = end
    previous = interpolates ? '' : '`'
    if (interpolates) interpolations.push(depth)
  }

  while (i < source.length) {
    const ch = source[i] as string
    const next = source[i + 1]
    if (ch === '/' && (next === '/' || next === '*')) {
      const end = endOfComment(source, i)
      out += blank(source.slice(i, end))
      i = end
      continue
    }
    if (ch === '/' && (REGEX_MAY_FOLLOW.has(previous) || REGEX_MAY_FOLLOW_WORD.has(word))) {
      const end = endOfRegex(source, i)
      out += source.slice(i, end)
      i = end
      previous = ')'
      word = ''
      continue
    }
    if (ch === "'" || ch === '"') {
      const end = endOfString(source, i)
      out += source.slice(i, end)
      i = end
      previous = ch
      word = ''
      continue
    }
    if (ch === '`') {
      out += ch
      word = ''
      copyTemplateText(i + 1)
      continue
    }
    if (ch === '{') depth += 1
    if (ch === '}') {
      if (interpolations[interpolations.length - 1] === depth) {
        interpolations.pop()
        out += ch
        word = ''
        copyTemplateText(i + 1)
        continue
      }
      depth -= 1
    }
    out += ch
    i += 1
    if (IDENTIFIER_CHAR.test(ch)) {
      word = IDENTIFIER_CHAR.test(previous) ? word + ch : ch
      previous = ch
    } else if (!/\s/.test(ch)) {
      previous = ch
      word = ''
    }
  }
  return out
}
