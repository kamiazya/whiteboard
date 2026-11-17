/**
 * What `packages/search` answers, recorded as `src/oracle/search.jsonl` for
 * the Rust port to replay (`crates/core/search/tests/search_oracle.rs`).
 *
 * Offsets are UTF-16 code units, as the TypeScript produces them, and every
 * double is its IEEE bits. A string holding an unpaired surrogate cannot be
 * written as JSON text a Rust reader accepts, so those inputs are recorded as
 * their code units (`{ units }`), which the replay counts and does not run: a
 * `&str` holds none.
 *
 * The inputs are the existing suites' fixtures plus a seeded stream built from
 * pieces that sit on the folding and tokenizing rules' edges: diacritics on
 * and off a Latin letter, decomposed and precomposed, kana with a dakuten,
 * compatibility forms, capitals that lowercase to several code points or by
 * context, characters outside the Basic Multilingual Plane, joiners, flags,
 * and a split pair.
 *
 * Besides the texts, the recording holds three tables over EVERY code point:
 * what folding answers for it alone, whether it is a letter or number, and
 * whether it is a mark. They are what the Rust Unicode tables are compared
 * against, so a table difference is ledgered by code point.
 */
import { randomFrom } from '@kamiazya/whiteboard-model/test-utils'
import { findFolded, foldForSearch, foldWithOffsets } from '../fold.js'
import { folderNamesOf } from '../folder-names.js'
import {
  documentTerms,
  excerpterFor,
  fullTextSearch,
  type SearchableDocument,
  tokenize,
  tokenizeForIndex,
} from '../full-text.js'
import { searchableTexts } from '../searchable-texts.js'
import { linkLabelsFrom, snippetAround } from '../snippet.js'
import { randomCjk } from './random-cjk.js'
import { searchableContents } from './search-oracle-contents.js'
import { segmentRecords } from './search-oracle-segments.js'

const SEED = 0x5ea4_c4e1
const FOLD_CASES = 3500
const FIND_CASES = 2500
const TOKEN_CASES = 3500
const TERMS_CASES = 260
const SNIPPET_CASES = 500
const EXCERPT_CASES = 300
const SEARCH_CASES = 160

// A record is plain JSON data; the writer is `JSON.stringify`, so nothing narrower is checked.
type Json = unknown

// `String#isWellFormed` is ES2024, past this package's `lib`.
const wellFormed = (text: string): boolean =>
  !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(text)

/** A string as JSON text, or as its code units when it is not well-formed. */
function str(text: string): Json {
  if (wellFormed(text)) return text
  return { units: Array.from({ length: text.length }, (_, i) => text.charCodeAt(i)) }
}

function hexBits(value: number): string {
  const view = new DataView(new ArrayBuffer(8))
  view.setFloat64(0, value)
  return view.getBigUint64(0).toString(16).padStart(16, '0')
}

const MASK = (1n << 64n) - 1n

/** FNV-1a over the UTF-8 of `text`, as 16 hex digits. */
function fnv64(text: string): string {
  let h = 0xcbf29ce484222325n
  for (const byte of new TextEncoder().encode(text))
    h = ((h ^ BigInt(byte)) * 0x100000001b3n) & MASK
  return h.toString(16).padStart(16, '0')
}

const byUnits = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** Pieces the seeded stream joins, each aimed at a rule. */
const PIECES: readonly string[] = [
  // Latin with and without diacritics, precomposed and decomposed.
  'a',
  'Z',
  'cafe',
  'Café',
  'café',
  'Équipe',
  'naïve',
  'Ångström',
  'Ångström',
  'Straße',
  'ẞ',
  'ß',
  'İstanbul',
  'ı',
  'ǅ',
  'ǈ',
  'ŉ',
  'ǰ',
  'ſ',
  'K',
  'ﬃ',
  'ﬁ',
  'ΐ',
  'ǆ',
  'Ø',
  'đ',
  'ł',
  'ñ',
  'ñ',
  'à́',
  'é',
  'ệ',
  'ệ',
  // Case folds that depend on context or expand.
  'Σ',
  'ΑΣ',
  'ΟΔΥΣΣΕΥΣ',
  'σς',
  'İ',
  'I',
  // Other scripts, whose marks are letters in their own right.
  'й',
  'й',
  'ё',
  'ё',
  'Привет',
  'مَرْحَبًا',
  'שָׁלוֹם',
  'สวัสดี',
  'हिन्दी',
  'ΑΒΓ',
  '한국어',
  '한',
  // Japanese and Chinese, voiced kana, halfwidth and fullwidth forms.
  '検索基盤',
  '你好世界',
  'がっこう',
  'が',
  'ｶﾞ',
  'ロケット',
  'ー',
  '豈',
  '図',
  '𠮷',
  '𠀀',
  'Ａ１',
  'ａｂｃ',
  '①',
  '㎒',
  'Ⅷ',
  'ℌ',
  '²',
  '½',
  '٣',
  '٣٤',
  '１２３',
  // Emoji, joiners, flags, keycaps.
  '🚀',
  '👨‍👩‍👧‍👦',
  '🇯🇵',
  '🇺🇸🇯🇵',
  '❤️',
  '1️⃣',
  '‍',
  '‌',
  '️',
  '𝒳',
  '𝐀𝐁',
  '𝚺',
  // Punctuation, whitespace, structure.
  ' ',
  '  ',
  '\n',
  '\t',
  ' ',
  '　',
  ',',
  '。',
  '-',
  '_',
  '/',
  '.',
  '[[',
  ']]',
  '![[',
  '#',
  '|',
  '**',
  '`',
  '10',
  'bm25',
  'v2.0',
  'a_b',
  '',
]

/** Pieces that are not well-formed UTF-16, and the edges of a pair. */
const BROKEN: readonly string[] = ['\ud83d', '\ude00', '😀'.slice(1), 'a\ud800b', '\udc00']

/** Hand-written texts: the suites' fixtures and the rules' edge cases. */
const HAND_WRITTEN: readonly string[] = [
  '',
  ' ',
  '\n\n',
  'cafe',
  'Café supplier list',
  'Équipe Ops',
  'equipe roster',
  'café',
  'Order beans from the Café du Monde today',
  'Order from the Café du Monde',
  'がっこう',
  'かが',
  'Full-Text SEARCH',
  'BM25で検索',
  '検索基盤',
  '図',
  '  ,, 。 a ',
  'QA完了後に検索基盤の日程を確定する。',
  'beta alpha beta',
  'たささたはな',
  'ロケット',
  'İstanbul ISTANBUL ıstanbul',
  'Σίσυφος ΟΔΥΣΣΕΥΣ',
  'ﬁnance ﬃ ① ㎒ Ａ',
  'é́ à ́x',
  'ｶﾞｷﾞ ガギ',
  '日本語とEnglishのmixed文',
  '👨‍👩‍👧‍👦 family 🇯🇵 flag 1️⃣ keycap',
  'x😀y',
  '\ud83d',
  '\ude00',
  'a\ud83d',
  '\ude00a',
]

/** `count` code points of `text` from code point `from`: never half a pair. */
const sliceCp = (text: string, from: number, count: number): string =>
  [...text].slice(from, from + count).join('')

function pick<T>(next: () => number, from: readonly T[]): T {
  return from[Math.floor(next() * from.length)] as T
}

/** Seeded texts: a few pieces joined, now and then a code point from anywhere. */
function seededText(next: () => number): string {
  const parts = 1 + Math.floor(next() * 7)
  let text = ''
  for (let i = 0; i < parts; i++) {
    const roll = next()
    if (roll < 0.07) {
      const at = Math.floor(next() * 0x2fffe)
      text += at >= 0xd800 && at <= 0xdfff ? 'x' : String.fromCodePoint(at)
    } else if (roll < 0.09) text += pick(next, BROKEN)
    else text += pick(next, PIECES)
    if (next() < 0.35) text += pick(next, [' ', ' ', '-', '、', '\n'])
  }
  return text
}

function texts(next: () => number, count: number): string[] {
  const out = [...HAND_WRITTEN]
  while (out.length < count) out.push(seededText(next))
  return out
}

/** What `foldWithOffsets` makes of a code point alone, and whether a mark after it is absorbed. */
function foldOf(cp: number): { out: string; latin: boolean } {
  const char = String.fromCodePoint(cp)
  const alone = foldWithOffsets(char).text
  // After a letter folded as Latin a mark is dropped into it; after anything
  // else it is kept, so the pair tells the two apart.
  const withMark = foldWithOffsets(`${char}́`).text
  return { out: alone, latin: cp !== 0x301 && withMark === alone }
}

const WORD = /^[\p{L}\p{N}]$/u
const MARK = /^\p{M}$/u

/** `[from, to]` inclusive ranges of the code points `test` holds for. */
function ranges(test: (cp: number) => boolean): [number, number][] {
  const out: [number, number][] = []
  let from = -1
  for (let cp = 0; cp <= 0x10ffff + 1; cp++) {
    const holds = cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) && test(cp)
    if (holds && from === -1) from = cp
    if (!holds && from !== -1) {
      out.push([from, cp - 1])
      from = -1
    }
  }
  return out
}

function tables(): Json[] {
  const fold: Json[] = []
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue
    const { out, latin } = foldOf(cp)
    if (out !== String.fromCodePoint(cp) || latin) fold.push([cp, out, latin])
  }
  return [
    { kind: 'fold-table', entries: fold },
    { kind: 'word-table', ranges: ranges((cp) => WORD.test(String.fromCodePoint(cp))) },
    { kind: 'mark-table', ranges: ranges((cp) => MARK.test(String.fromCodePoint(cp))) },
  ]
}

function foldRecords(next: () => number): Json[] {
  return texts(next, FOLD_CASES).map((text) => ({
    kind: 'fold',
    in: str(text),
    out: str(foldForSearch(text)),
  }))
}

function findRecords(next: () => number): Json[] {
  const out: Json[] = []
  const pool = texts(next, FIND_CASES)
  for (let i = 0; i < FIND_CASES; i++) {
    const text = pool[i] as string
    // A needle that is a slice of the text half the time, so a hit is common.
    let needle: string
    if (next() < 0.55 && text.length > 0) {
      const from = Math.floor(next() * text.length)
      needle = text.slice(from, from + 1 + Math.floor(next() * 6))
    } else needle = pick(next, pool)
    if (next() < 0.3) needle = needle.toUpperCase()
    const found = findFolded(text, needle)
    out.push({
      kind: 'find',
      text: str(text),
      needle: str(needle),
      at: found === undefined ? null : [found.index, found.length],
    })
  }
  return out
}

function tokenRecords(next: () => number): Json[] {
  return texts(next, TOKEN_CASES).map((text) => ({
    kind: 'tokens',
    in: str(text),
    query: tokenize(text).map(str),
    index: tokenizeForIndex(text).map(str),
  }))
}

const ALSO: Record<string, ((text: string) => string) | undefined> = {
  none: undefined,
  upper: (text) => text.toUpperCase(),
  empty: () => '',
  suffix: () => 'zzextra',
}

function countsRecord(counts: ReadonlyMap<string, number>): Json {
  const sorted = [...counts].sort(([a], [b]) => byUnits(a, b))
  if (sorted.length <= 300) return sorted.map(([token, n]) => [str(token), n])
  return { n: sorted.length, fnv: fnv64(sorted.map(([token, n]) => `${token}\t${n}\n`).join('')) }
}

function termsRecords(next: () => number): Json[] {
  const out: Json[] = []
  const names = Object.keys(ALSO)
  const pool = texts(next, 400)
  const record = (path: string, name: string | undefined, bodies: string[], also: string) => {
    const terms = documentTerms(
      { path, ...(name === undefined ? {} : { name }), texts: bodies },
      ALSO[also],
    )
    out.push({
      kind: 'terms',
      path: str(path),
      ...(name === undefined ? {} : { name: str(name) }),
      texts: bodies.map(str),
      also,
      counts: countsRecord(terms.counts),
      length: terms.length,
    })
  }
  while (out.length < TERMS_CASES - 3) {
    const bodies = Array.from({ length: Math.floor(next() * 4) }, () => pick(next, pool))
    const name = next() < 0.6 ? pick(next, pool) : undefined
    record(`notes/${pick(next, pool)}`.slice(0, 60), name, bodies, pick(next, names))
  }
  // Past the ceiling the term bag stops where it is, which insertion order decides.
  record('big', undefined, [randomCjk(9000, 7)], 'none')
  record('big', 'name', [randomCjk(3000, 11), randomCjk(9000, 13)], 'upper')
  record('', undefined, [pick(next, pool).repeat(40)], 'none')
  return out.filter((record) => (record as { counts: unknown }).counts !== undefined)
}

function linkEntries(next: () => number): { documentId: string; path: string; name?: string }[] {
  const names = ['Transformer', '変換器', 'Café', 'a|b', '[x]', '']
  return Array.from({ length: 1 + Math.floor(next() * 4) }, (_, i) => ({
    documentId: `01H${i}`,
    path: `folder/note-${i}`,
    ...(next() < 0.6 ? { name: pick(next, names) } : {}),
  }))
}

const LINKS = [
  '[[folder/note-0]]',
  '![[folder/note-1]]',
  '[[folder/note-0#Heading]]',
  '[[01H0|alias]]',
  '[[unknown/target]]',
  '[[ ]]',
  '[[a',
]

function snippetBody(next: () => number): string {
  const filler = pick(next, [
    'x ',
    'あ',
    'word ',
    '\n',
    '🙂',
    'é',
    '# Title\n',
    '- item\n',
    '> quote\n',
  ])
  const parts: string[] = []
  const count = 1 + Math.floor(next() * 12)
  for (let i = 0; i < count; i++) {
    parts.push(next() < 0.25 ? pick(next, LINKS) : filler.repeat(1 + Math.floor(next() * 30)))
    if (next() < 0.3) parts.push(pick(next, PIECES))
  }
  return parts.join('')
}

function snippetRecords(next: () => number): Json[] {
  const out: Json[] = []
  for (let i = 0; i < SNIPPET_CASES; i++) {
    const text = i < 20 ? (HAND_WRITTEN[i] as string) : snippetBody(next)
    if (!wellFormed(text)) continue
    const index = Math.floor(next() * (text.length + 1))
    const length = Math.floor(next() * 12)
    const entries = next() < 0.5 ? linkEntries(next) : null
    const labelOf = entries === null ? undefined : linkLabelsFrom(entries)
    out.push({
      kind: 'snippet',
      text,
      index,
      length,
      entries,
      out: snippetAround(text, index, length, labelOf),
    })
  }
  const labelled = linkEntries(next)
  const labelOf = linkLabelsFrom(labelled)
  out.push({
    kind: 'labels',
    entries: labelled,
    targets: [...labelled.flatMap((e) => [e.documentId, e.path]), 'unknown', ''].map((target) => ({
      target,
      label: labelOf(target) ?? null,
    })),
  })
  return out
}

function excerptRecords(next: () => number): Json[] {
  const out: Json[] = []
  const pool = texts(next, 300).filter(wellFormed)
  for (let i = 0; i < EXCERPT_CASES; i++) {
    const bodies = Array.from({ length: 1 + Math.floor(next() * 5) }, () =>
      next() < 0.5 ? snippetBody(next) : pick(next, pool),
    )
    const source = pick(next, bodies)
    const from = Math.floor(next() * Math.max(1, [...source].length - 4))
    const query =
      next() < 0.7 ? sliceCp(source, from, 1 + Math.floor(next() * 14)) : pick(next, pool)
    const entries = next() < 0.4 ? linkEntries(next) : null
    const labelOf = entries === null ? undefined : linkLabelsFrom(entries)
    out.push({
      kind: 'excerpt',
      query,
      texts: bodies,
      entries,
      out: excerpterFor(query, labelOf)({ texts: bodies }),
    })
  }
  // A query past the token ceiling is cut to its first 64 distinct tokens.
  const long = Array.from({ length: 100 }, (_, i) => `w${i}`).join(' ')
  out.push({
    kind: 'excerpt',
    query: long,
    texts: ['w99 only', 'w3 and w70', long],
    entries: null,
    out: excerpterFor(long)({ texts: ['w99 only', 'w3 and w70', long] }),
  })
  return out
}

function searchDocuments(next: () => number, pool: string[]): SearchableDocument[] {
  const count = 1 + Math.floor(next() * 8)
  return Array.from({ length: count }, (_, i) => ({
    documentId: `d${i}`,
    path: next() < 0.5 ? `notes/d${i}` : `a/${sliceCp(pick(next, pool), 0, 12)}/d${i}`,
    ...(next() < 0.6 ? { name: pick(next, pool) } : {}),
    texts: Array.from({ length: Math.floor(next() * 4) }, () => pick(next, pool)),
    ...(next() < 0.3 ? { folders: [sliceCp(pick(next, pool), 0, 20)] } : {}),
  }))
}

function searchRecords(next: () => number): Json[] {
  const out: Json[] = []
  const pool = texts(next, 400).filter(wellFormed)
  const names = Object.keys(ALSO)
  for (let i = 0; i < SEARCH_CASES; i++) {
    const documents = searchDocuments(next, pool)
    const donor = pick(next, documents)
    const source = pick(next, [donor.path, donor.name ?? '', ...donor.texts, ...pool])
    const from = Math.floor(next() * Math.max(1, [...source].length - 3))
    const query = sliceCp(source, from, 1 + Math.floor(next() * 10))
    const options = {
      ...(next() < 0.5 ? { limit: pick(next, [1, 2, 3, 10]) } : {}),
      ...(next() < 0.3 ? { excerpts: next() < 0.5 } : {}),
      ...(next() < 0.4 ? { alsoIndex: pick(next, names) } : {}),
      ...(next() < 0.3 ? { linkLabels: true } : {}),
    }
    const hits = fullTextSearch(documents, query, {
      ...(options.limit === undefined ? {} : { limit: options.limit }),
      ...(options.excerpts === undefined ? {} : { excerpts: options.excerpts }),
      ...(options.alsoIndex === undefined ? {} : { alsoIndex: ALSO[options.alsoIndex] }),
      ...(options.linkLabels === true ? { linkLabel: linkLabelsFrom(documents) } : {}),
    })
    out.push({
      kind: 'search',
      documents,
      query,
      options,
      hits: hits.map((hit) => ({
        documentId: hit.documentId,
        score: hexBits(hit.score),
        contexts: hit.contexts,
      })),
    })
  }
  return out
}

function contentRecords(): Json[] {
  return searchableContents().map((content: ReturnType<typeof searchableContents>[number]) => ({
    kind: 'searchable-texts',
    content: content as unknown as Json,
    out: searchableTexts(content),
  }))
}

function folderRecords(next: () => number): Json[] {
  const segments = ['a', 'b', 'projects', 'ops', '日本', 'café', '']
  const out: Json[] = []
  for (let i = 0; i < 80; i++) {
    const depth = Math.floor(next() * 5)
    const path = Array.from({ length: depth + 1 }, () => pick(next, segments)).join('/')
    const prefixes = path.split('/').map((_, at, all) => all.slice(0, at + 1).join('/'))
    const names: [string, string][] = prefixes
      .filter(() => next() < 0.5)
      .map((prefix) => [prefix, pick(next, ['Ops', 'Team A', '運用', '', 'x/y'])])
    if (next() < 0.2) names.push([pick(next, ['', '/', 'zzz']), 'Stray'])
    out.push({
      kind: 'folders',
      path,
      names,
      out: folderNamesOf(path, new Map(names)),
    })
  }
  return out
}

function meta(): Json {
  return {
    kind: 'meta',
    seed: SEED,
    unicode: process.versions.unicode,
    cases: {
      fold: FOLD_CASES,
      find: FIND_CASES,
      tokens: TOKEN_CASES,
      terms: TERMS_CASES,
      snippet: SNIPPET_CASES,
      excerpt: EXCERPT_CASES,
      search: SEARCH_CASES,
    },
  }
}

/** Every line of the recording, in order. */
export function recordedLines(): string[] {
  const next = randomFrom(SEED)
  const records: Json[] = [
    meta(),
    ...tables(),
    ...foldRecords(next),
    ...findRecords(next),
    ...tokenRecords(next),
    ...termsRecords(next),
    ...snippetRecords(next),
    ...excerptRecords(next),
    ...searchRecords(next),
    ...contentRecords(),
    ...folderRecords(next),
    ...segmentRecords(),
  ]
  return records.map((record) => JSON.stringify(record))
}
