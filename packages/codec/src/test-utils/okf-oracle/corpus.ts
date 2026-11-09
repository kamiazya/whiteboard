import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { OkfMarkdownDocument } from '../../okf/schema.js'
import { Dice, decodeLiteral, mulberry32, writerValue } from '../frontmatter-oracle/corpus.js'
import {
  BAD_ACTORS,
  body,
  frontmatter,
  GOOD_TIMES,
  type Obj,
  render,
  trustEvent,
} from './documents.js'
import { EDGE_TEXTS } from './edges.js'
import { type ReaderCase, readerCase, type WriterCase, writerCase } from './oracle.js'

/**
 * The inputs the recorded oracle asks the TypeScript about: whole OKF
 * documents for the reader (the repository's own, hand-written edges, then
 * seeded frontmatters wrapped in fences and damaged), document objects for
 * the writer. Generated from a seed so a re-recording is reproducible; the
 * recording holds the inputs themselves, so a test needs no generator.
 */
const READER_SEED = 0x0ba5e5
const WRITER_SEED = 0x5ca1ab
const MAX_TEXT = 3000
const MAX_FILE = 1200
const FILES = 120

const repoRoot = (): string =>
  execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: import.meta.dirname,
    encoding: 'utf8',
  }).trim()

/** Whole files that open with a fence, and the documents the codec's own tests spell as literals. */
function repositoryDocuments(): string[] {
  const root = repoRoot()
  const tracked = (glob: string): string[] =>
    execFileSync('git', ['ls-files', glob], { cwd: root, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
  const found: string[] = []
  const files = tracked('*.md')
    .map((file) => readFileSync(join(root, file), 'utf8'))
    .filter((text) => text.startsWith('---\n') && text.length < MAX_FILE)
  // Every Nth, so the sample spans the repository and the recording stays small.
  for (let i = 0; i < files.length; i += Math.ceil(files.length / FILES))
    found.push(files[i] as string)
  for (const file of tracked('packages/codec/src/**/*.test.ts')) {
    const source = readFileSync(join(root, file), 'utf8')
    for (const m of source.matchAll(/(['"`])(---\\n(?:(?!\1)[^\\\n]|\\.)*?)\1/g)) {
      const literal = decodeLiteral(m[2] ?? '')
      if (literal !== undefined && !literal.includes('${')) found.push(literal)
    }
  }
  return found
}

const CLOSERS = [
  '\n---\n',
  '\n---\n',
  '\n---\n',
  '\n---',
  '\n---\r',
  '\n---x',
  '\n--- \n',
  '\n---\n\n',
]

/** A frontmatter's YAML between fences, with the line endings and closer a document may have. */
function wrap(yaml: string, d: Dice): string {
  const eol = d.chance(0.12) ? '\r\n' : '\n'
  const closer = d.chance(0.85) ? '\n---\n' : d.pick(CLOSERS)
  return `---${eol}${yaml.replaceAll('\n', eol)}${closer.replaceAll('\n', eol)}${body(d)}`
}

const INSERTS = [
  '\n',
  '\r',
  '-',
  '---',
  '\n---\n',
  ':',
  '"',
  ' ',
  '\t',
  '#',
  '\ufeff',
  '\ud800',
  '\udc00',
]

type Mutation = (text: string, d: Dice) => string

const MUTATIONS: Mutation[] = [
  (t, d) => t.slice(0, d.int(t.length + 1)),
  (t, d) => {
    const at = d.int(t.length)
    return t.slice(0, at) + t.slice(at + 1)
  },
  (t, d) => {
    const at = d.int(t.length + 1)
    return t.slice(0, at) + d.pick(INSERTS) + t.slice(at)
  },
  (t, d) => d.pick([' ', '\n', '\ufeff', '\r\n', '--\n', '# c\n']) + t,
  (t) => t.replace(/\n---/, '\n--'),
  (t) => t.replace(/^---/, '--'),
  (t) => t.replace(/\n---/, '\n---\n---'),
  (t) => t.replace(/\r?\n/, '\r\n'),
  (t) => atFirstLineBreak(t, '\n__proto__: 1\n'),
  (t) => atFirstLineBreak(t, '\nx: {"__proto__": 1}\n'),
  (t) => atFirstLineBreak(t, '\nverified:\n  by: human:a\n  at: 2026-01-02T03:04:05Z\n'),
  (t) => atFirstLineBreak(t, '\ngenerated: {by: " x", at: now}\n'),
  (t) => atFirstLineBreak(t, '\nfacets:\n  Bad: 1\n'),
  (t) => atFirstLineBreak(t, '\nfacetsRaw: {type: x}\n'),
  (t) => atFirstLineBreak(t, '\nx: &a [1]\ny: *a\n'),
  (t) => atFirstLineBreak(t, `\nd: ${'['.repeat(33)}${']'.repeat(33)}\n`),
  (t) => t.replace(/type:/, 'Type:'),
  (t) => t.replace(/\n(---)/, '\n\ud800$1'),
]

/**
 * `text` with its first line break replaced by `insert`: a mutation adds a
 * line just after the opening fence, so only the first break is meant.
 */
function atFirstLineBreak(text: string, insert: string): string {
  const at = text.indexOf('\n')
  return at < 0 ? text : text.slice(0, at) + insert + text.slice(at + 1)
}

function reachable(text: string, seen: Set<string>): boolean {
  if (seen.has(text) || text.length > MAX_TEXT) return false
  seen.add(text)
  return true
}

function generatedText(d: Dice, pool: readonly string[]): string {
  const base = d.chance(0.15) && pool.length > 0 ? d.pick(pool) : wrap(render(frontmatter(d), d), d)
  let text = base
  for (let i = 0, n = d.chance(0.45) ? 1 + d.int(2) : 0; i < n; i++) {
    text = (d.pick(MUTATIONS) as Mutation)(text, d)
  }
  return text
}

/** `count` reader inputs. */
export function readerCases(count: number): ReaderCase[] {
  const d = new Dice(mulberry32(READER_SEED))
  const seen = new Set<string>()
  const texts: string[] = []
  const pool = repositoryDocuments()
  for (const text of [...pool, ...EDGE_TEXTS]) if (reachable(text, seen)) texts.push(text)
  for (let guard = 0; texts.length < count && guard < count * 20; guard++) {
    const text = generatedText(d, pool)
    if (reachable(text, seen)) texts.push(text)
  }
  return texts.map(readerCase)
}

/** An event with `by` and `at` ahead of what else it carries: the order the Rust type writes in. */
function writerEvent(d: Dice): unknown {
  const { by, at, ...rest } = trustEvent(d, false) as Obj
  return { by, at, ...rest }
}

/** A document as the schema orders it: the order the Rust type writes in. */
function validFrontmatter(d: Dice): Obj {
  const fm: Obj = { type: d.chance(0.9) ? d.pick(['note', 'concept', 'x y', 'é', '😀']) : 'n' }
  for (const key of ['title', 'description', 'resource']) {
    if (d.chance(0.4))
      fm[key] = d.pick(['a title', 'x: y', '', 'é\n', '# hash', '"q"', 'a'.repeat(120)])
  }
  if (d.chance(0.4))
    fm.tags = Array.from({ length: d.int(4) }, () => d.pick(['a', 'b c', '1', 'true', '']))
  if (d.chance(0.2)) fm.view = d.pick(['visual.shape/v0', 'other'])
  if (d.chance(0.25)) fm.generated = writerEvent(d)
  if (d.chance(0.25)) fm.verified = Array.from({ length: d.int(3) }, () => writerEvent(d))
  if (d.chance(0.4)) fm.facets = facetRecord(d, FACET_WRITE_KEYS)
  if (d.chance(0.4)) fm.facetsRaw = facetRecord(d, RAW_WRITE_KEYS)
  return fm
}

/** Keys that decide the canonical order: integer-like ones, and a BMP-high one against a supplementary one. */
const FACET_WRITE_KEYS = [
  'visual.shape/v0',
  'a.b/v1',
  'z.z/v0',
  '10',
  '2',
  '01',
  'b',
  'B',
  '\uff5e',
  '\u{1f600}',
  '\ue000',
  'é',
]
const RAW_WRITE_KEYS = [
  ...FACET_WRITE_KEYS,
  'status',
  'sources',
  'type',
  'title',
  'facets',
  'verified',
  'tags',
]

function facetRecord(d: Dice, keys: readonly string[]): Obj {
  const entries = Array.from({ length: d.int(5) }, (): [string, unknown] => [
    d.pick(keys),
    writerValue(d, 3),
  ])
  return Object.fromEntries(entries)
}

function nest(levels: number): unknown {
  return Array.from({ length: levels }).reduce<unknown>((inner) => ({ k: [inner, 1] }), 'leaf')
}

/** Facets that are large or deeply nested: 250 keys, and 12 and 18 levels (JSON caps a reader's recursion at 128). */
const LARGE: Obj[] = [
  Object.fromEntries(
    Array.from({ length: 250 }, (_, i) => [`p${i % 7}.k${i}/v${i}`, { n: i, s: `value ${i}` }]),
  ),
  { 'a.b/v0': nest(12) },
  { 'a.b/v0': nest(18) },
]

const BAD_STRING_ACTORS = BAD_ACTORS.filter((actor) => typeof actor === 'string')

const UNSAFE_PAYLOADS: (() => unknown)[] = [
  () => Number.NaN,
  () => Number.POSITIVE_INFINITY,
  () => [1, Number.NEGATIVE_INFINITY],
  () => 10n,
  () => 'x\ufeffy',
  () => ({ 'k\ufeff': 1 }),
  () => JSON.parse('{"__proto__": 1}'),
  () => ({ a: JSON.parse('{"__proto__": {"b": 1}}') }),
  () => 'lone \ud800 surrogate',
  () => ({ '\udc00': 1 }),
]

function unsafeDocument(d: Dice): OkfMarkdownDocument {
  const fm = validFrontmatter(d)
  const bucket = d.pick(['facets', 'facetsRaw'])
  fm[bucket] = {
    ...(fm[bucket] as Obj | undefined),
    [d.pick(['a.b/v0', 'status'])]: (d.pick(UNSAFE_PAYLOADS) as () => unknown)(),
  }
  if (d.chance(0.2)) fm.title = (d.pick(UNSAFE_PAYLOADS) as () => unknown)()
  if (d.chance(0.1)) fm.generated = { by: d.pick(BAD_STRING_ACTORS), at: d.pick(GOOD_TIMES) }
  return { frontmatter: fm, body: body(d) } as OkfMarkdownDocument
}

function validDocument(d: Dice): OkfMarkdownDocument {
  return { frontmatter: validFrontmatter(d), body: body(d) } as OkfMarkdownDocument
}

/** `count` writer inputs: mostly documents the writer writes, a tenth it refuses. */
export function writerCases(count: number): WriterCase[] {
  const d = new Dice(mulberry32(WRITER_SEED))
  const generated = Array.from({ length: count - LARGE.length }, () =>
    writerCase(d.chance(0.12) ? unsafeDocument(d) : validDocument(d)),
  )
  return [
    ...LARGE.map((facets) =>
      writerCase({ frontmatter: { type: 'note', facets }, body: '' } as OkfMarkdownDocument),
    ),
    ...generated,
  ]
}
