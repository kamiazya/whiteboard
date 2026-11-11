import { createRequire } from 'node:module'
import { uaxSegments } from '../../layout/nodes/uax-segments.js'

/**
 * The recorded answers of the TypeScript line breaker, which the Rust port
 * (`crates/core/canvas-render/src/linebreak`) replays exactly (ADR-0054 step 7). The subject is `uaxSegments`, the one call of `css-line-break` in
 * this package, so what is recorded is what the layout reads: the UTF-16
 * offsets of every segment end but the last.
 *
 * Small corpora are recorded string by string. The large ones (every ordered
 * triple of class representatives, a seeded stream of mixed strings, the
 * table's own census) are recorded as one 32-bit digest per chunk of their
 * answers, and the Rust test regenerates the strings from the `meta` record
 * and compares digests: a recording of a million answers would be megabytes of
 * JSON, and the strings are cheaper to derive than to store.
 */

const require = createRequire(import.meta.url)
const trie = (require('css-line-break/dist/lib/LineBreak.js') as { UnicodeTrie: Trie }).UnicodeTrie
interface Trie {
  get(codePoint: number): number
}

/** The trie's raw value for a code point (class, plus 50 for a letter or number). */
export const rawClass = (codePoint: number): number => trie.get(codePoint)

export const LAST_CODE_POINT = 0x10ffff
export const RAW_BLOCK = 4096
export const CENSUS_BLOCK = 4096
export const MIXED = { seed: 0x1b0a_5eed, count: 200_000, minLen: 1, maxLen: 12, chunk: 1000 }

/** A text as UTF-16 code units; code points above U+FFFF are a pair, a lone surrogate one unit. */
function unitsOf(codePoints: readonly number[]): number[] {
  const units: number[] = []
  for (const cp of codePoints) {
    if (cp > 0xffff) {
      const v = cp - 0x10000
      units.push(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff))
    } else {
      units.push(cp)
    }
  }
  return units
}

const stringOf = (units: readonly number[]): string => {
  let text = ''
  for (let i = 0; i < units.length; i += 4096) {
    text += String.fromCharCode(...units.slice(i, i + 4096))
  }
  return text
}

/** What the layout reads: the interior segment ends of `uaxSegments`, in UTF-16 units. */
export function breaksOf(units: readonly number[]): number[] {
  const ends: number[] = []
  let at = 0
  for (const segment of uaxSegments(stringOf(units))) {
    at += segment.length
    ends.push(at)
  }
  return ends.slice(0, -1)
}

export type TextRecord =
  | { kind: 'text'; c: string; t: string; b: number[] }
  | { kind: 'text'; c: string; u: number[]; b: number[] }
export interface DigestRecord {
  kind: 'digest'
  c: string
  k: number
  n: number
  h: number
}
export interface MetaRecord {
  kind: 'meta'
  version: string
  reps: number[]
  alphabet: number[]
  mixed: typeof MIXED
  kanji: number
  latin: [number, number]
}
export type OracleRecord = MetaRecord | TextRecord | DigestRecord

const wellFormed = (units: readonly number[]): boolean => {
  for (let i = 0; i < units.length; i += 1) {
    const u = units[i] ?? 0
    if (u >= 0xd800 && u <= 0xdbff) {
      const low = units[i + 1] ?? 0
      if (low < 0xdc00 || low > 0xdfff) return false
      i += 1
    } else if (u >= 0xdc00 && u <= 0xdfff) {
      return false
    }
  }
  return true
}

export function textRecord(c: string, codePoints: readonly number[]): TextRecord {
  const units = unitsOf(codePoints)
  const b = breaksOf(units)
  return wellFormed(units)
    ? { kind: 'text', c, t: stringOf(units), b }
    : { kind: 'text', c, u: units, b }
}

/** The units a text record holds, whichever way it was written. */
export const unitsOfRecord = (record: TextRecord): number[] =>
  'u' in record
    ? record.u
    : Array.from({ length: record.t.length }, (_, i) => record.t.charCodeAt(i))

/** FNV-1a over 32-bit words; the Rust side is `(h ^ v).wrapping_mul(16777619)`. */
export class Digest {
  private h = 0x811c9dc5
  feed(word: number): void {
    this.h = Math.imul(this.h ^ word, 16777619)
  }
  get value(): number {
    return this.h >>> 0
  }
}

/** One string's answer into a digest: its breaks, then a sentinel no offset equals. */
export function feedAnswer(digest: Digest, codePoints: readonly number[]): void {
  for (const b of breaksOf(unitsOf(codePoints))) digest.feed(b)
  digest.feed(0xffff_ffff)
}

/** mulberry32: `next()` is the next u32. */
function mulberry32(seed: number): () => number {
  let a = seed | 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return (t ^ (t >>> 14)) >>> 0
  }
}

/**
 * Code points chosen for what moves a break, each named by what it is:
 * Latin, digits, spaces and joiners, ASCII and fullwidth punctuation, quotes,
 * hyphens, small kana, the prolonged sound mark, kanji, Hangul syllables and
 * jamo, Thai, Hebrew, Arabic, emoji with skin tones and regional indicators,
 * currency, marks, the two openers LB30 exempts, and lone surrogates.
 */
const NAMED = [
  ...'aZ09',
  ...'  ​‌‍⁠\n\r\t\u0085﻿­',
  ...`.,;:!?'"()[]{}/\\-_+=%$#@&*~\`|<>^`,
  ...'（）「」『』。、！？：；，．％＄＋〜ー・゠…‥—–‐‑«»“”¡¿',
  ...'ぁぃゃゅょっァッヵヶㇰあアヽゝ日本中文',
  ...'한국어가각각',
  ...'สวัสดีฺ฿ๆ',
  ...'אבا',
  ...'¥€£¢°‰′',
  ...'゙́̀️ั',
  ...'〈〉（）〈〉—⸺￼�´',
  ...'1١１',
].map((ch) => ch.codePointAt(0) ?? 0)
const NAMED_ASTRAL = [
  0x1d400, 0x1d401, 0x1f600, 0x1f44d, 0x1f3fb, 0x1f3fd, 0x1f468, 0x1f469, 0x1f467, 0x1f1ef, 0x1f1f5,
  0x1f1fa, 0x1f1f8, 0x20000, 0x2fffd, 0x30000, 0x3fffd, 0x10ffff, 0xe0001, 0xe0100,
]
const LONE_SURROGATES = [0xd800, 0xdbff, 0xdc00, 0xdfff]

/**
 * One representative per distinct raw trie value (its first code point) and the
 * code points the walk reads by number rather than by class.
 */
export function representatives(): number[] {
  const firsts = new Map<number, number>()
  for (let cp = 0; cp <= LAST_CODE_POINT; cp += 1) {
    const raw = rawClass(cp)
    if (!firsts.has(raw)) firsts.set(raw, cp)
  }
  const reps = new Set<number>([
    ...firsts.values(),
    0x2329,
    0xff08,
    0x20,
    0x41,
    0x30,
    0x200d,
    0x4e00,
    ...LONE_SURROGATES,
    0x1f1e6,
    0x1f468,
    0x20000,
    0x2fffd,
    0x30000,
    0x3fffd,
    0x40000,
    0x10ffff,
  ])
  return [...reps].sort((a, b) => a - b)
}

export function alphabet(reps: readonly number[]): number[] {
  return [...new Set([...NAMED, ...NAMED_ASTRAL, ...LONE_SURROGATES, ...reps])]
}

/** The seeded mixed strings of chunk `chunk`, as code points. */
export function mixedChunk(alpha: readonly number[], chunk: number): number[][] {
  const { seed, chunk: size, minLen, maxLen } = MIXED
  const next = mulberry32(seed + chunk)
  const strings: number[][] = []
  for (let i = 0; i < size; i += 1) {
    const length = minLen + (next() % (maxLen - minLen + 1))
    const text: number[] = []
    for (let j = 0; j < length; j += 1) text.push(alpha[next() % alpha.length] ?? 0)
    strings.push(text)
  }
  return strings
}
