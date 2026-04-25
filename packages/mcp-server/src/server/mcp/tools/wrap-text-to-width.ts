// Auto-wrap helper for box_with_label. It splits a single input string into
// multiple lines that fit within maxWidth using estimateTextWidth. Strategy:
// preserve explicit newlines, wrap ASCII/whitespace text on word boundaries,
// wrap wide characters per character, and force-split oversized tokens.

import { estimateTextWidth } from './estimate-text-width.js'

function isWideCodePoint(cp: number): boolean {
  if (cp >= 0x2e80 && cp <= 0xd7af) return true
  if (cp >= 0xf900 && cp <= 0xfaff) return true
  if (cp >= 0xfe30 && cp <= 0xfe4f) return true
  if (cp >= 0xff00 && cp <= 0xffef) return true
  if (cp >= 0x1f000 && cp <= 0x1ffff) return true
  return false
}

// Split into individual characters, preserving surrogate pairs. Last-resort path for overly long tokens.
function splitPerChar(text: string): string[] {
  return Array.from(text)
}

// Tokenize mostly-ASCII paragraphs on whitespace. When wide characters are mixed
// in, treat wide-character boundaries as token boundaries too.
function tokenize(text: string): string[] {
  const tokens: string[] = []
  let buf = ''
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    if (ch === ' ' || ch === '\t') {
      if (buf) {
        tokens.push(buf)
        buf = ''
      }
      // Do not emit whitespace itself as a token; it only separates words.
    } else if (isWideCodePoint(cp)) {
      if (buf) {
        tokens.push(buf)
        buf = ''
      }
      tokens.push(ch)
    } else {
      buf += ch
    }
  }
  if (buf) tokens.push(buf)
  return tokens
}

// Force-split tokens that are wider than maxWidth.
function splitTokenByWidth(token: string, maxWidth: number, fontSize: number): string[] {
  const out: string[] = []
  let cur = ''
  for (const ch of Array.from(token)) {
    const candidate = cur + ch
    if (estimateTextWidth(candidate, fontSize) <= maxWidth) {
      cur = candidate
    } else {
      if (cur) out.push(cur)
      cur = ch
    }
  }
  if (cur) out.push(cur)
  return out
}

// Pack tokens greedily into wrapped lines. Narrow-token joins use a single space;
// wide-character joins use no separator.
function isNarrowToken(tok: string): boolean {
  const cp = tok.codePointAt(0) ?? 0
  return !isWideCodePoint(cp)
}

function joiner(prev: string, next: string): string {
  return isNarrowToken(prev) && isNarrowToken(next) ? ' ' : ''
}

function packLine(
  tokens: string[],
  maxWidth: number,
  fontSize: number,
): string[] {
  const lines: string[] = []
  let cur = ''
  for (const rawTok of tokens) {
    // Split over-wide tokens at character boundaries.
    const pieces = estimateTextWidth(rawTok, fontSize) <= maxWidth
      ? [rawTok]
      : splitTokenByWidth(rawTok, maxWidth, fontSize)
    for (const tok of pieces) {
      if (!cur) {
        cur = tok
        continue
      }
      const candidate = cur + joiner(cur.slice(-1), tok) + tok
      if (estimateTextWidth(candidate, fontSize) <= maxWidth) {
        cur = candidate
      } else {
        lines.push(cur)
        cur = tok
      }
    }
  }
  if (cur) lines.push(cur)
  return lines
}

export function wrapTextToWidth(
  text: string,
  maxWidth: number,
  fontSize: number = 20,
): string[] {
  if (text === '') return ['']
  if (maxWidth <= 0) return splitPerChar(text)

  const paragraphs = text.split('\n')
  const out: string[] = []
  for (const para of paragraphs) {
    if (para === '') {
      out.push('')
      continue
    }
    const tokens = tokenize(para)
    if (tokens.length === 0) {
      out.push('')
      continue
    }
    const lines = packLine(tokens, maxWidth, fontSize)
    if (lines.length === 0) out.push('')
    else out.push(...lines)
  }
  return out
}
