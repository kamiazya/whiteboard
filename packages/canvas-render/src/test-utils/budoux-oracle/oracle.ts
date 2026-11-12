import { jaModel } from '../../vendor/budoux/ja-model.js'
import { Parser } from '../../vendor/budoux/parser.js'
import { EMOJI_AND_SURROGATES, KANA, KANJI, MIXED_SCRIPTS, REAL } from './texts.js'

/**
 * The recorded answers of the vendored BudouX parser, which the Rust port
 * (`crates/core/canvas-render/src/budoux`) replays exactly (ADR-0054 step 7).
 * The subject is `Parser.parseBoundaries` over the Japanese model, the one
 * call the layout reaches through `parse`: the UTF-16 offsets at which a phrase
 * boundary falls.
 *
 * Small corpora are recorded string by string. Three are cheaper to derive
 * than to store: every prefix of each real text, and a seeded stream of strings
 * over the model's own key units, recorded as one 32-bit digest per text or per
 * chunk; the Rust test regenerates the strings from the recorded texts and the
 * `meta` record. One string per model entry is recorded whole, built so that its
 * entry is looked up at least once.
 */

const parser = new Parser(jaModel)
type Weights = Map<string, Map<string, number>>
/** Each group's window: its offset from the index and its length (the parser's own table, restated). */
const WINDOW = (group: string): { from: number; len: number } => {
  const n = Number(group.slice(2))
  if (group.startsWith('UW')) return { from: n - 4, len: 1 }
  if (group.startsWith('BW')) return { from: n - 3, len: 2 }
  return { from: n - 4, len: 3 }
}

const STREAM = { seed: 0x0b0d_0a11, count: 100_000, minLen: 1, maxLen: 16, chunk: 1000 }

const unitsOfString = (text: string): number[] =>
  Array.from({ length: text.length }, (_, i) => text.charCodeAt(i))

const stringOf = (units: readonly number[]): string => {
  let text = ''
  for (let i = 0; i < units.length; i += 4096) {
    text += String.fromCharCode(...units.slice(i, i + 4096))
  }
  return text
}

/** What the layout reads: the phrase boundary offsets of a text, in UTF-16 units. */
export const breaksOf = (units: readonly number[]): number[] =>
  parser.parseBoundaries(stringOf(units))

/** The phrases the layout reads, as their lengths in UTF-16 units. */
export const phraseLengths = (units: readonly number[]): number[] =>
  parser.parse(stringOf(units)).map((phrase) => phrase.length)

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
interface MetaRecord {
  kind: 'meta'
  model: string
  entries: number
  alphabet: number[]
  stream: typeof STREAM
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

function textRecord(c: string, units: readonly number[]): TextRecord {
  const b = breaksOf(units)
  return wellFormed(units)
    ? { kind: 'text', c, t: stringOf(units), b }
    : { kind: 'text', c, u: [...units], b }
}

/** The units a text record holds, whichever way it was written. */
export const unitsOfRecord = (record: TextRecord): number[] =>
  'u' in record ? record.u : unitsOfString(record.t)

/** FNV-1a over 32-bit words; the Rust side is `(h ^ v).wrapping_mul(16777619)`. */
class Digest {
  private h = 0x811c9dc5
  feed(word: number): void {
    this.h = Math.imul(this.h ^ word, 16777619)
  }
  get value(): number {
    return this.h >>> 0
  }
  /** One string's answer: its boundaries, then a sentinel no offset equals. */
  answer(units: readonly number[]): void {
    for (const b of breaksOf(units)) this.feed(b)
    this.feed(0xffff_ffff)
  }
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

/** The model's entries as `[group, key]`. */
export const modelEntries = (): [string, string][] =>
  Object.entries(jaModel).flatMap(([group, weights]) =>
    Object.keys(weights).map((key): [string, string] => [group, key]),
  )

/**
 * The alphabet of the generated corpora: every unit any key holds, so a
 * window can match, plus the units that make a window miss or split a pair
 * (Latin, a digit, a space, a line feed, the halves of one emoji, lone
 * surrogates).
 */
function alphabet(): number[] {
  const units = new Set<number>([
    0x61, 0x42, 0x30, 0x20, 0x0a, 0xd83d, 0xde00, 0xd800, 0xdbff, 0xdc00, 0xdfff,
  ])
  for (const [, key] of modelEntries()) for (const unit of unitsOfString(key)) units.add(unit)
  return [...units].sort((a, b) => a - b)
}

const plain = jaModel as Readonly<Record<string, Readonly<Record<string, number>>>>
const TOTAL = Object.values(plain)
  .flatMap((weights) => Object.values(weights))
  .reduce((sum, weight) => sum + weight, 0)

/** What every group but `skipped` adds at `index`: the model's weights over the windows there. */
function othersAt(text: readonly number[], index: number, skipped: string): number {
  let sum = 0
  for (const group of Object.keys(plain)) {
    if (group === skipped) continue
    const { from, len } = WINDOW(group)
    const key = String.fromCharCode(...text.slice(index + from, index + from + len))
    sum += plain[group]?.[key] ?? 0
  }
  return sum
}

/**
 * One string per model entry, built so that the entry decides: its key sits
 * where its group's window reads it, and the units around it are steered (a
 * few sweeps of sampled replacements) until the other groups' sum lies within
 * the entry's weight of the cut-off, so that the cut falls with the entry's
 * sign and not against it.
 */
function entryTexts(alpha: readonly number[]): number[][] {
  const next = mulberry32(0x0e17_71e5)
  const pick = () => alpha[next() % alpha.length] ?? 0
  return modelEntries().map(([group, key]) => {
    const index = 4 + (next() % 3)
    const text = Array.from({ length: index + 5 }, pick)
    const { from } = WINDOW(group)
    const keyUnits = unitsOfString(key)
    keyUnits.forEach((unit, offset) => {
      text[index + from + offset] = unit
    })
    const free = [index - 3, index - 2, index - 1, index, index + 1, index + 2].filter(
      (at) => at < index + from || at >= index + from + keyUnits.length,
    )
    const weight = Math.abs(plain[group]?.[key] ?? 0)
    const gap = () => Math.abs(othersAt(text, index, group) - TOTAL / 2)
    for (let attempt = 0; attempt < 24 && gap() >= weight; attempt += 1) {
      for (const at of free) text[at] = pick()
      for (let sweep = 0; sweep < 12 && gap() >= weight; sweep += 1) {
        for (const at of free) {
          let best = { unit: text[at] ?? 0, gap: gap() }
          for (let trial = 0; trial < 64; trial += 1) {
            text[at] = pick()
            const candidate = gap()
            if (candidate < best.gap) best = { unit: text[at] ?? 0, gap: candidate }
          }
          text[at] = best.unit
        }
      }
    }
    return text
  })
}

/** The seeded stream's chunk `chunk`, as unit arrays. */
function streamChunk(alpha: readonly number[], chunk: number): number[][] {
  const { seed, chunk: size, minLen, maxLen } = STREAM
  const next = mulberry32(seed + chunk)
  return Array.from({ length: size }, () => {
    const length = minLen + (next() % (maxLen - minLen + 1))
    return Array.from({ length }, () => alpha[next() % alpha.length] ?? 0)
  })
}

/** The model entries a set of texts looks up with a key present, as `group:key`. */
export function reach(texts: readonly (readonly number[])[]): Set<string> {
  const hits = new Set<string>()
  const watched = new Parser(jaModel)
  const weights = (watched as unknown as { model: Weights }).model
  for (const [group, original] of weights) {
    const counting = new Map(original)
    counting.get = (key: string) => {
      const weight = Map.prototype.get.call(original, key)
      if (weight !== undefined) hits.add(`${group}:${key}`)
      return weight
    }
    weights.set(group, counting)
  }
  for (const text of texts) watched.parseBoundaries(stringOf(text))
  return hits
}

const asUnits = (text: string | readonly number[]): readonly number[] =>
  typeof text === 'string' ? unitsOfString(text) : text

/** Every record of the recording, in the order the files hold them. */
export function recording(): OracleRecord[] {
  const alpha = alphabet()
  const records: OracleRecord[] = [
    {
      kind: 'meta',
      model: 'budoux@0.9.0 ja',
      entries: modelEntries().length,
      alphabet: alpha,
      stream: STREAM,
    },
  ]
  const small: [string, readonly (string | readonly number[])[]][] = [
    ['real', REAL],
    ['kana', KANA],
    ['kanji', KANJI],
    ['scripts', MIXED_SCRIPTS],
    ['emoji', EMOJI_AND_SURROGATES],
  ]
  for (const [corpus, texts] of small) {
    for (const text of texts) records.push(textRecord(corpus, asUnits(text)))
  }
  for (const text of entryTexts(alpha)) records.push(textRecord('entry', text))
  REAL.forEach((text, k) => {
    const units = unitsOfString(text)
    const digest = new Digest()
    for (let end = 0; end <= units.length; end += 1) digest.answer(units.slice(0, end))
    records.push({ kind: 'digest', c: 'prefixes', k, n: units.length + 1, h: digest.value })
  })
  for (let k = 0; k < STREAM.count / STREAM.chunk; k += 1) {
    const digest = new Digest()
    for (const text of streamChunk(alpha, k)) digest.answer(text)
    records.push({ kind: 'digest', c: 'stream', k, n: STREAM.chunk, h: digest.value })
  }
  return records
}

/** The strings a recording asks about: its texts, and the stream when `stream` is true. */
export function askedTexts(records: readonly OracleRecord[], stream: boolean): number[][] {
  const asked = records.filter((r): r is TextRecord => r.kind === 'text').map(unitsOfRecord)
  if (!stream) return asked
  const alpha = alphabet()
  for (let k = 0; k < STREAM.count / STREAM.chunk; k += 1) asked.push(...streamChunk(alpha, k))
  return asked
}

/**
 * The entries whose sign the recorded answer of their own string depends on:
 * the string is parsed again with that one weight negated (the total kept), and
 * it is counted when the boundaries differ from the recorded ones. Answers
 * `group:key` for each.
 */
export function decidedEntries(records: readonly OracleRecord[]): Set<string> {
  const aimed = records.filter((r): r is TextRecord => r.kind === 'text' && r.c === 'entry')
  const watched = new Parser(jaModel)
  const weights = (watched as unknown as { model: Weights }).model
  const decided = new Set<string>()
  modelEntries().forEach(([group, key], i) => {
    const record = aimed[i]
    const map = weights.get(group)
    const weight = map?.get(key)
    if (record === undefined || map === undefined || weight === undefined) return
    map.set(key, -weight)
    const answer = watched.parseBoundaries(stringOf(unitsOfRecord(record)))
    map.set(key, weight)
    if (JSON.stringify(answer) !== JSON.stringify(record.b)) decided.add(`${group}:${key}`)
  })
  return decided
}
