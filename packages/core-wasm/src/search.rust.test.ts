import { readFileSync } from 'node:fs'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { beforeAll, describe, expect, it } from 'vitest'
import { CoreInputRefused } from './index.js'
import { loadCore } from './load.js'
import type { SearchCore } from './search.js'

type SearchableDocument = Parameters<SearchCore['fullTextSearch']>[0][number]
type AlsoIndex = NonNullable<NonNullable<Parameters<SearchCore['fullTextSearch']>[2]>['alsoIndex']>

// The shim over the artifact `stage:wasm` copied into artifacts/, held to the
// answers `packages/search` recorded (`search.jsonl`, which the TypeScript
// re-records and fails on when it drifts) with the same allowances the native
// replay (`crates/core/search/tests`) makes: the Unicode tables the core
// carries differ from the recording runtime's at the code points the ledger
// names, and a text holding one of them is replayed but may differ. An input
// the recording holds as code units because it was ill-formed is not replayed
// here either; what the shim does with one is its own test below.

const bytes = () => readFileSync(new URL('../artifacts/whiteboard_wasm_bg.wasm', import.meta.url))
const RECORDING = new URL('../../search/src/oracle/search.jsonl', import.meta.url)
const LEDGER = new URL('../../../crates/core/search/tests/unicode_table_diff.json', import.meta.url)

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
type Recorded = { [key: string]: Json }

const records = (kind: string): Recorded[] =>
  readFileSync(RECORDING, 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as Recorded)
    .filter((record) => record.kind === kind)

const ledgered = (): Set<number> => {
  const ledger = JSON.parse(readFileSync(LEDGER, 'utf8')) as Record<string, { ranges: number[][] }>
  const set = new Set<number>()
  for (const table of ['fold', 'word', 'mark']) {
    for (const [from, to] of ledger[table]?.ranges ?? []) {
      for (let cp = from as number; cp <= (to as number); cp++) set.add(cp)
    }
  }
  return set
}

function strings(value: Json, into: string[] = []): string[] {
  if (typeof value === 'string') into.push(value)
  else if (Array.isArray(value)) for (const item of value) strings(item, into)
  else if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) strings(item, into)
  }
  return into
}

const illFormed = (value: Json): boolean =>
  Array.isArray(value)
    ? value.some(illFormed)
    : value !== null && typeof value === 'object'
      ? 'units' in value || Object.values(value).some(illFormed)
      : false

interface Tally {
  replayed: number
  illFormed: number
  tolerated: number
}

let held: Set<number>
const holdsLedgered = (record: Recorded): boolean =>
  strings(record).some((text) => [...text].some((c) => held.has(c.codePointAt(0) as number)))

/** Replays every `kind` record; a difference passes only where the ledger allows it. */
function replay(
  kind: string,
  answer: (record: Recorded) => Json,
  recorded: (record: Recorded) => Json,
  tolerable: (record: Recorded) => boolean = holdsLedgered,
): Tally {
  const tally: Tally = { replayed: 0, illFormed: 0, tolerated: 0 }
  for (const record of records(kind)) {
    if (illFormed(record)) {
      tally.illFormed++
      continue
    }
    tally.replayed++
    const got = answer(record)
    const want = recorded(record)
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      expect(
        tolerable(record),
        `${kind} ${JSON.stringify(record)}\n got ${JSON.stringify(got)}`,
      ).toBe(true)
      tally.tolerated++
    }
  }
  return tally
}

const utf16 = (a: string, b: string): number => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const d = a.charCodeAt(i) - b.charCodeAt(i)
    if (d !== 0) return d
  }
  return a.length - b.length
}

const ALSO: { [name: string]: AlsoIndex | undefined } = {
  upper: (text) => text.toUpperCase(),
  empty: () => '',
  suffix: () => 'zzextra',
}

function fnv64(text: string): string {
  let hash = 0xcbf29ce484222325n
  for (const byte of new TextEncoder().encode(text)) {
    hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return hash.toString(16).padStart(16, '0')
}

const text = (value: Json | undefined): string => value as string
const texts = (value: Json | undefined): string[] => value as string[]
const hex = (score: number): string => {
  const view = new DataView(new ArrayBuffer(8))
  view.setFloat64(0, score)
  return view.getBigUint64(0).toString(16).padStart(16, '0')
}

interface Entry {
  documentId: string
  path: string
  name?: string
}

let search: SearchCore

beforeAll(async () => {
  search = (await loadCore(bytes())).search
  held = ledgered()
})

describe('the search shim over the built artifact, against the recorded TypeScript', () => {
  it('folds every text as the recording did', () => {
    const tally = replay(
      'fold',
      (r) => search.foldForSearch(text(r.in)),
      (r) => r.out,
    )
    expect(tally).toEqual({ replayed: 3200, illFormed: 300, tolerated: 1 })
  })

  it('finds every needle at the span the recording names', () => {
    const tally = replay(
      'find',
      (r) => {
        const at = search.findFolded(text(r.text), text(r.needle))
        return at === undefined ? null : [at.index, at.length]
      },
      (r) => r.at,
    )
    expect(tally).toEqual({ replayed: 2131, illFormed: 369, tolerated: 0 })
  })

  it('cuts every text into the query and index tokens the recording names', () => {
    const tally = replay(
      'tokens',
      (r) => [search.tokenize(text(r.in)), search.tokenizeForIndex(text(r.in))],
      (r) => [r.query, r.index],
    )
    expect(tally).toEqual({ replayed: 3241, illFormed: 259, tolerated: 8 })
  })

  it('counts every term bag as the recording counted it', () => {
    const tally = replay(
      'terms',
      (r) => {
        const terms = search.documentTerms(
          {
            path: text(r.path),
            ...(r.name === undefined ? {} : { name: text(r.name) }),
            texts: texts(r.texts),
          },
          ALSO[text(r.also)],
        )
        const sorted = [...terms.counts].sort(([a], [b]) => utf16(a, b))
        const counts = Array.isArray(r.counts)
          ? sorted.map(([token, n]) => [token, n])
          : {
              n: sorted.length,
              fnv: fnv64(sorted.map(([token, n]) => `${token}\t${n}\n`).join('')),
            }
        return { counts, length: terms.length }
      },
      (r) => ({ counts: r.counts, length: r.length }),
    )
    expect(tally).toEqual({ replayed: 211, illFormed: 49, tolerated: 1 })
  })

  it('cuts every excerpt as the recording cut it, links labelled by their listing', () => {
    for (const [kind, expected] of [
      ['snippet', { replayed: 500, illFormed: 0, tolerated: 0 }],
      ['snippet-run', { replayed: 666, illFormed: 0, tolerated: 0 }],
    ] as const) {
      const tally = replay(
        kind,
        (r) => {
          const labels = Array.isArray(r.entries)
            ? search.linkLabels(r.entries as unknown as Entry[])
            : undefined
          try {
            return search.snippetAround(text(r.text), r.index as number, r.length as number, labels)
          } finally {
            labels?.release()
          }
        },
        (r) => r.out,
        () => false,
      )
      expect(tally, kind).toEqual(expected)
    }
  })

  it('chooses every excerpt set as the recording chose it', () => {
    const tally = replay(
      'excerpt',
      (r) => {
        const labels = Array.isArray(r.entries)
          ? search.linkLabels(r.entries as unknown as Entry[])
          : undefined
        try {
          return search.excerpts(text(r.query), [texts(r.texts)], labels)[0] as string[]
        } finally {
          labels?.release()
        }
      },
      (r) => r.out,
    )
    expect(tally).toEqual({ replayed: 301, illFormed: 0, tolerated: 0 })
  })

  it('ranks every search as the recording ranked it, scores to the bit', () => {
    const tally = replay(
      'search',
      (r) => {
        const documents = r.documents as unknown as SearchableDocument[]
        const options = r.options as { [key: string]: Json }
        const labels = options.linkLabels === undefined ? undefined : search.linkLabels(documents)
        try {
          const hits = search.fullTextSearch(documents, text(r.query), {
            ...(options.limit === undefined ? {} : { limit: options.limit as number }),
            ...(options.excerpts === undefined ? {} : { excerpts: options.excerpts as boolean }),
            ...(options.alsoIndex === undefined
              ? {}
              : { alsoIndex: ALSO[text(options.alsoIndex)] as AlsoIndex }),
            ...(labels === undefined ? {} : { linkLabels: labels }),
          })
          return hits.map((hit) => ({
            documentId: hit.documentId,
            score: hex(hit.score),
            contexts: [...hit.contexts],
          }))
        } finally {
          labels?.release()
        }
      },
      (r) => r.hits,
    )
    expect(tally).toEqual({ replayed: 160, illFormed: 0, tolerated: 0 })
  })

  it('lists the texts of every content as the recording listed them', () => {
    const tally = replay(
      'searchable-texts',
      (r) => {
        const content = r.content as { [key: string]: Json }
        return content.kind === 'markdown'
          ? search.searchableTexts({
              kind: 'markdown',
              body: text(content.body),
              ...(content.description === undefined
                ? {}
                : { description: text(content.description) }),
            })
          : search.searchableTexts({
              kind: 'spatial',
              canvas: content.canvas as unknown as SpatialCanvas,
            })
      },
      (r) => r.out,
      () => false,
    )
    expect(tally).toEqual({ replayed: 11, illFormed: 0, tolerated: 0 })
  })

  it('names the folders of every path as the recording named them', () => {
    const tally = replay(
      'folders',
      (r) => search.folderNamesOf(text(r.path), new Map(r.names as [string, string][])),
      (r) => r.out,
      () => false,
    )
    expect(tally).toEqual({ replayed: 80, illFormed: 0, tolerated: 0 })
  })
})

describe('a corpus held in the instance', () => {
  const doc = (documentId: string, textsOf: string[], folders?: string[]): SearchableDocument => ({
    documentId,
    path: `notes/${documentId}`,
    texts: textsOf,
    ...(folders === undefined ? {} : { folders }),
  })

  it('answers what the same documents answer in one call, through upserts and removals', () => {
    const documents = [
      doc('a', ['alpha beta', 'gamma']),
      doc('b', ['alpha alpha alpha x y z'], ['ops']),
      doc('c', ['unrelated'], ['alpha']),
      doc('d', ['検索 alpha']),
    ]
    const index = search.createIndex()
    try {
      for (const each of documents) expect(index.upsert(each)).toBe(false)
      expect(index.upsert(documents[0] as SearchableDocument)).toBe(true)
      expect(index.size().documents).toBe(4)
      const once = search.fullTextSearch(documents, 'alpha', { excerpts: false, limit: 50 })
      expect(index.search('alpha', 50)).toEqual(
        once.map(({ documentId, score }) => ({ documentId, score })),
      )
      expect(index.remove('b')).toBe(true)
      expect(index.remove('b')).toBe(false)
      const rest = search.fullTextSearch(
        documents.filter((each) => each.documentId !== 'b'),
        'alpha',
        { excerpts: false, limit: 50 },
      )
      expect(index.search('alpha', 50)).toEqual(
        rest.map(({ documentId, score }) => ({ documentId, score })),
      )
      expect(index.search('   ')).toEqual([])
    } finally {
      index.release()
    }
  })

  it('refuses a released index, and releasing twice is harmless', () => {
    const index = search.createIndex()
    index.release()
    index.release()
    expect(() => index.search('alpha')).toThrow(CoreInputRefused)
    expect(() => index.upsert(doc('a', ['x']))).toThrow(CoreInputRefused)
  })

  it('refuses a released label set, and a query past the cap', () => {
    const labels = search.linkLabels([{ documentId: '01H0', path: 'a/b', name: 'Shown' }])
    expect(search.snippetAround('see [[01H0]] now', 4, 8, labels)).toBe('see Shown now')
    labels.release()
    expect(() => search.snippetAround('see [[01H0]]', 0, 1, labels)).toThrow(CoreInputRefused)
    const index = search.createIndex()
    try {
      expect(() => index.search('q'.repeat(4097))).toThrowError(
        expect.objectContaining({ code: 'input-too-large' }),
      )
    } finally {
      index.release()
    }
  })

  it('indexes the expansion of every text and the folder names as written', () => {
    const index = search.createIndex()
    try {
      index.upsert(doc('a', ['rocket'], ['ops']), (text) => (text === 'rocket' ? 'launch' : ''))
      expect(index.search('launch').map((hit) => hit.documentId)).toEqual(['a'])
      expect(index.search('ops').map((hit) => hit.documentId)).toEqual(['a'])
    } finally {
      index.release()
    }
  })

  it('reports the bytes it holds and gives them back on release of a document', () => {
    const index = search.createIndex()
    try {
      index.upsert(doc('a', ['alpha beta']))
      const before = index.size().bytes
      expect(before).toBeGreaterThan(0)
      index.remove('a')
      expect(index.size()).toEqual({ documents: 0, bytes: 0 })
    } finally {
      index.release()
    }
  })
})

describe('what the shim does with a string the core cannot hold', () => {
  it('answers a lone surrogate as the replacement character, every offset unchanged', () => {
    const lone = 'caf\uD800e'
    const whole = 'caf�e'
    expect(search.tokenize(lone)).toEqual(search.tokenize(whole))
    expect(search.findFolded(`${lone} x`, 'x')).toEqual({ index: 6, length: 1 })
    expect(search.foldForSearch(lone)).toBe(search.foldForSearch(whole))
    expect(search.snippetAround(lone, 3, 1)).toBe(whole)
  })
})

describe('what the shim refuses', () => {
  it('throws CoreInputRefused for a snippet offset that is no offset', () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => search.snippetAround('abc', bad, 1)).toThrow(CoreInputRefused)
    }
  })

  it('throws input-too-large for a request past the entry before calling the artifact', () => {
    expect(() => search.foldForSearch('x'.repeat(8 * 1024 * 1024))).toThrowError(
      expect.objectContaining({ operation: 'search_op', code: 'input-too-large' }),
    )
  })
})
