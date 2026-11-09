import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  AWKWARD,
  BOOLS,
  BRANCH_EDGES,
  blockScalarGrid,
  DOUBLE_QUOTED,
  FRAGMENTS,
  KEY_POOL,
  KEYS,
  MORE_BRANCH_EDGES,
  MUTATION_CHARS,
  NULLS,
  NUMBER_POOL,
  NUMBERS,
  SINGLE_QUOTED,
  STRINGS,
  SUBSET_EDGES,
  VERY_DEEP,
  WORDS,
  WORDS_LONG,
} from './corpus-data.js'
import { type ReaderCase, readerCase, type WriterCase, writerCase, writtenText } from './oracle.js'

/**
 * The inputs the recorded oracle asks the TypeScript about: texts in and
 * near the frontmatter subset for the reader, frontmatter values for the
 * writer. Generated from a seed, so a re-recording is reproducible; the
 * recording holds the inputs themselves, so a test needs no generator.
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

/** Longer texts add file size and no new construct. */
const MAX_TEXT = 1500
const READER_SEED = 0x0f1e2d
const WRITER_SEED = 0x3c4b5a
/** The checkout's root, which `git` answers for any directory inside it. */
const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  cwd: import.meta.dirname,
  encoding: 'utf8',
}).trim()

type Random = () => number

function mulberry32(seed: number): Random {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

class Dice {
  constructor(private readonly random: Random) {}
  int(n: number): number {
    return Math.floor(this.random() * n)
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)] as T
  }
  chance(p: number): boolean {
    return this.random() < p
  }
}

function scalarAtom(d: Dice): string {
  const r = d.int(100)
  if (r < 25) return d.pick(NUMBERS)
  if (r < 35) return d.pick(BOOLS)
  if (r < 42) return d.pick(NULLS)
  if (r < 75) return d.pick(STRINGS)
  if (r < 90) return d.pick(DOUBLE_QUOTED)
  return d.pick(SINGLE_QUOTED)
}

const key = (d: Dice): string =>
  d.chance(0.7)
    ? d.pick(['type', 'title', 'a', 'b', 'c', 'tags', 'k1', 'k2', 'status'])
    : d.pick(KEYS)

function flowNode(d: Dice, depth: number): string {
  if (depth > 3 || d.chance(0.5)) return scalarAtom(d).replace(/^$/, '~')
  if (d.chance(0.5)) {
    const items = Array.from({ length: d.int(4) }, () => flowNode(d, depth + 1))
    return `[${items.join(d.pick([', ', ',', ' , ']))}${d.chance(0.1) ? ',' : ''}]`
  }
  const pairs = Array.from({ length: d.int(4) }, () =>
    d.chance(0.1) ? key(d) : `${key(d)}: ${flowNode(d, depth + 1)}`,
  )
  return `{${pairs.join(', ')}}`
}

function blockMap(d: Dice, indent: number, depth: number): string {
  const lines: string[] = []
  for (let i = 0, n = 1 + d.int(4); i < n; i++) {
    const pad = ' '.repeat(indent)
    const k = key(d)
    const r = d.int(100)
    if (depth < 4 && r < 20)
      lines.push(`${pad}${k}:`, blockMap(d, indent + d.pick([1, 2, 2, 4]), depth + 1))
    else if (depth < 4 && r < 35)
      lines.push(`${pad}${k}:`, blockSeq(d, d.chance(0.3) ? indent : indent + 2, depth + 1))
    else if (r < 45) lines.push(`${pad}${k}: ${flowNode(d, depth)}`)
    else if (r < 50) lines.push(`${pad}${k}:`)
    else lines.push(`${pad}${k}: ${scalarAtom(d)}`)
  }
  return lines.join('\n')
}

function blockSeq(d: Dice, indent: number, depth: number): string {
  const pad = ' '.repeat(indent)
  const lines: string[] = []
  for (let i = 0, n = 1 + d.int(3); i < n; i++) {
    const r = d.int(100)
    const nested = (text: string): string => {
      const rows = text.split('\n')
      rows[0] = `${pad}- ${(rows[0] ?? '').trimStart()}`
      return rows.join('\n')
    }
    if (depth < 4 && r < 25) lines.push(nested(blockMap(d, indent + 2, depth + 1)))
    else if (depth < 4 && r < 35) lines.push(nested(blockSeq(d, indent + 2, depth + 1)))
    else if (r < 45) lines.push(`${pad}- ${flowNode(d, depth)}`)
    else if (r < 50) lines.push(`${pad}-`)
    else lines.push(`${pad}- ${scalarAtom(d)}`)
  }
  return lines.join('\n')
}

/** Quoted and block scalars spanning lines, where folding and chomping decide. */
function multiline(d: Dice): string {
  const lines = Array.from({ length: 1 + d.int(4) }, () => d.pick(WORDS))
  const pad = ' '.repeat(d.pick([1, 2, 2, 3, 4]))
  const tail = d.chance(0.3) ? '\nnext: 1' : ''
  const r = d.int(100)
  const indented = (rest: string[]) => rest.map((l) => (d.chance(0.8) ? pad : '') + l).join('\n')
  if (r < 25) return `k: ${lines[0]}\n${indented(lines.slice(1))}${tail}`
  if (r < 45) {
    const q = d.pick(['"', "'"])
    return `k: ${q}${lines[0]}\n${indented(lines.slice(1))}${q}${tail}`
  }
  const head = d.pick([
    '|',
    '>',
    '|-',
    '>-',
    '|+',
    '>+',
    '|2',
    '>1',
    '|-2',
    '|2-',
    '|0',
    '|10',
    '| # c',
    '|x',
  ])
  const body = lines
    .map((l) => (l === '' && d.chance(0.5) ? '' : pad + (d.chance(0.15) ? ' ' : '') + l))
    .join('\n')
  const text = body + d.pick(['', '\n', '\n\n', '\n  \n'])
  return (
    (d.chance(0.2) ? `${head}\n${text}` : `k: ${head}\n${text}`) +
    (d.chance(0.4) ? '\nnext: 1' : '')
  )
}

function deep(d: Dice): string {
  const levels = 28 + d.int(8)
  if (d.chance(0.5)) {
    const open = d.pick(['[', '{a: '])
    return `x: ${open.repeat(levels)}1${(open === '[' ? ']' : '}').repeat(levels)}`
  }
  return `${Array.from({ length: levels }, (_, i) => `${'  '.repeat(i)}a${i}:`).join('\n')} 1`
}

function mutate(d: Dice, text: string): string {
  const chars = [...text]
  for (let i = 0, n = 1 + d.int(3); i < n; i++) {
    const at = d.int(chars.length + 1)
    const r = d.int(100)
    if (r < 40) chars.splice(at, 0, d.pick([...MUTATION_CHARS]))
    else if (r < 70) chars.splice(at, 1)
    else chars[at] = d.pick([...MUTATION_CHARS])
  }
  return chars.join('')
}

/** Frontmatters the repository's markdown files carry, and the OKF fixtures of the codec's own tests. */
function repositoryFrontmatters(): string[] {
  const tracked = (glob: string) =>
    execFileSync('git', ['ls-files', glob], { cwd: REPO_ROOT, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
  const found: string[] = []
  const fence = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/
  for (const file of tracked('*.md')) {
    const match = fence.exec(readFileSync(join(REPO_ROOT, file), 'utf8'))
    if (match?.[1] !== undefined) found.push(match[1])
  }
  for (const file of tracked('packages/*/src/**/*.test.ts')) {
    const text = readFileSync(join(REPO_ROOT, file), 'utf8')
    for (const m of text.matchAll(/(['"`])---\\n((?:(?!\1).)*?)\\n---/g)) {
      try {
        const yaml = JSON.parse(
          `"${(m[2] ?? '').replace(/"/g, '\\"').replace(/\\'/g, "'")}"`,
        ) as string
        if (!yaml.includes('${')) found.push(yaml)
      } catch {
        // not a plain string literal
      }
    }
  }
  return found
}

const STRUCTURE_WEIGHTS: [string, number][] = [
  ['scalar', 16],
  ['key', 8],
  ['structure', 18],
  ['multiline', 12],
  ['edge', 6],
  ['deep', 2],
  ['noise', 6],
  ['written', 16],
  ['mutation', 16],
]

/** A block map with its line breaks, comments or separators disturbed. */
function noisy(d: Dice): string {
  const map = blockMap(d, 0, 1)
  const r = d.int(100)
  if (r < 30) return map.replace(/\n/g, '\r\n')
  if (r < 50) return map.replace(/\n/g, '\n# c\n')
  if (r < 70) return map.replace(/\n/g, '  \n\n')
  if (r < 85) return map.replace(/: /, ':\t')
  return `# head\n${map}\n# tail\n`
}

function keyed(d: Dice): string {
  return Array.from(
    { length: 1 + d.int(4) },
    () => `${d.pick(KEYS)}: ${d.chance(0.5) ? d.pick(NUMBERS) : 'v'}`,
  ).join('\n')
}

function structured(d: Dice): string {
  if (d.chance(0.85)) return blockMap(d, 0, 0)
  return d.chance(0.5) ? blockSeq(d, 0, 0) : flowNode(d, 0)
}

type Maker = (d: Dice, corpus: readonly string[], written: () => string) => string

const MAKERS: Record<string, Maker> = {
  scalar: (d) => `type: note\n${key(d)}: ${scalarAtom(d)}${d.chance(0.3) ? ' # c' : ''}`,
  key: keyed,
  structure: structured,
  multiline,
  edge: (d) => `type: note\n${d.pick(SUBSET_EDGES)}`,
  deep,
  noise: noisy,
  written: (_d, _corpus, written) => written(),
  mutation: (d, corpus) =>
    mutate(d, d.chance(0.3) ? d.pick(corpus) : d.chance(0.5) ? blockMap(d, 0, 0) : multiline(d)),
}

/** The category a roll of the dice lands in, by weight. */
function category(d: Dice): string {
  const total = STRUCTURE_WEIGHTS.reduce((sum, [, w]) => sum + w, 0)
  let roll = d.int(total)
  for (const [name, weight] of STRUCTURE_WEIGHTS) {
    if (roll < weight) return name
    roll -= weight
  }
  return 'mutation'
}

/** `count` reader inputs: the repository's frontmatters, the named edges, then generated texts. */
export function readerCases(count: number): ReaderCase[] {
  const d = new Dice(mulberry32(READER_SEED))
  const corpus = repositoryFrontmatters().filter((y) => y.length < 2000)
  const writtenPool = writerValues(d, 600).map((v) => {
    try {
      return writtenText(v)
    } catch {
      return 'type: note'
    }
  })
  const seen = new Set<string>()
  const texts: string[] = []
  const add = (text: string) => {
    // A lone surrogate cannot reach a Rust `&str`; the TypeScript refuses one by name.
    if (seen.has(text) || text.length > MAX_TEXT || /\n---/.test(text) || LONE_SURROGATE.test(text))
      return
    seen.add(text)
    texts.push(text)
  }
  for (const text of corpus) add(text)
  for (const text of [
    ...SUBSET_EDGES,
    ...BRANCH_EDGES,
    ...MORE_BRANCH_EDGES,
    ...blockScalarGrid(),
    ...VERY_DEEP,
  ])
    add(text)
  for (let guard = 0; texts.length < count && guard < count * 20; guard++) {
    const make = MAKERS[category(d)] as Maker
    add(make(d, corpus, () => d.pick(writtenPool)))
  }
  return texts.map(readerCase)
}

function nastyString(d: Dice): string {
  const r = d.int(100)
  if (r < 30) return d.pick(AWKWARD)
  if (r < 70) return Array.from({ length: d.int(12) }, () => d.pick(FRAGMENTS)).join('')
  if (r < 85)
    return Array.from({ length: 10 + d.int(50) }, () => d.pick(WORDS_LONG)).join(d.pick([' ', '']))
  return Array.from({ length: d.int(30) }, () =>
    String.fromCodePoint(
      d.pick([0x20, 0x61, 0xe9, 0x1f600, 0x0a, 0x09, 0x85, 0x7f, 0x01, 0x2028, 0xa0, 0x3000]),
    ),
  ).join('')
}

function writerValue(d: Dice, depth: number): unknown {
  const r = d.int(100)
  if (depth > 3 || r < 55) {
    const t = d.int(100)
    if (t < 12) return d.pick(NUMBER_POOL)
    if (t < 20) return d.pick([true, false, null])
    if (t < 25) return d.int(2000) - 1000
    return nastyString(d)
  }
  if (r < 78) return Array.from({ length: d.int(5) }, () => writerValue(d, depth + 1))
  const entries = Array.from({ length: d.int(5) }, (): [string, unknown] => [
    d.chance(0.5) ? d.pick(KEY_POOL) : nastyString(d),
    writerValue(d, depth + 1),
  ])
  return Object.fromEntries(entries.filter(([k]) => k !== '__proto__'))
}

/** `count` frontmatter objects as `serializeOkf` is handed them. */
function writerValues(d: Dice, count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, () => {
    const base: Record<string, unknown> = d.chance(0.5) ? { type: 'note' } : {}
    const extra = writerValue(d, 1)
    const body =
      extra !== null && typeof extra === 'object' && !Array.isArray(extra)
        ? extra
        : { value: extra }
    const merged = { ...base, ...body } as Record<string, unknown>
    delete merged.facets
    delete merged.facetsRaw
    return merged
  })
}

/** Values `serializeOkf` refuses, each by a different rule. */
function unsafeValues(): Record<string, unknown>[] {
  return [
    { a: Number.NaN },
    { a: Number.POSITIVE_INFINITY },
    { a: [1, Number.NEGATIVE_INFINITY] },
    { a: 10n },
    { a: 'x\uFEFFy' },
    { 'k\uFEFF': 1 },
    Object.fromEntries([['__proto__', 1]]),
    { a: { b: Object.fromEntries([['__proto__', 1]]) } },
  ]
}

const PROSE = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ')
const LINE = (n: number, tail = ''): string => `${'a'.repeat(n)}${tail}`

function nested(levels: number, leaf: unknown): unknown {
  return Array.from({ length: levels }).reduce<unknown>((inner) => ({ k: inner }), leaf)
}

/** Lines at, just under and just over the 80-column fold. */
function widthValues(): Record<string, unknown>[] {
  return [75, 76, 77, 78, 79, 80, 81].flatMap((n) => [
    { k: `${LINE(n)}\nz` },
    { k: `z\n${LINE(n)}\nz` },
    { k: `${LINE(n, ' b')}\nz` },
    { k: [`${LINE(n)}\nz`] },
  ])
}

/** Prose nested deep enough that the indent passes the minimum content width. */
function deepValues(): Record<string, unknown>[] {
  const short = Array.from({ length: 50 }, (_, i) => String.fromCharCode(97 + (i % 26))).join(' ')
  return [
    { k: nested(36, `${PROSE}\n  x`) },
    { k: nested(36, PROSE) },
    { k: nested(31, `${short}\n  x`) },
    { k: nested(33, `${short}\n  x`) },
    { k: nested(34, `${short} ${short}`) },
  ]
}

/** Values that decide one branch of the writer each, found by mutating the Rust port. */
function branchValues(): Record<string, unknown>[] {
  return [
    ...widthValues(),
    ...deepValues(),
    { k: 'x\n \n' },
    { k: 'x\n\n \n' },
    { k: 'x \n\n' },
    { k: 'x\t\n\n\n' },
    { k: 'x\n ' },
    { k: 'x\n\t' },
    { k: '\n ' },
    { k: 'a b \n  ' },
    { k: `${PROSE}\n  indented\n${PROSE}` },
    { k: `${PROSE}\n  indented\n\n${PROSE}\n` },
    { k: `${PROSE}\n\n  ${PROSE}\n\n\n` },
    { k: ` ${PROSE}\nx` },
    { k: `  ${PROSE}\n${PROSE}` },
    { k: `\n ${PROSE}` },
    { k: ` ${PROSE}\n  ${PROSE}\n` },
    { k: `\n\n${PROSE}\n` },
    { k: '...\nx' },
    { k: 'a\n...\nb' },
    { k: '%\nx' },
    { k: 'a\n%b' },
    { k: '---\nx' },
    { k: '...' },
    { k: 'x\r\n---\ny' },
    { k: [PROSE] },
    { k: { j: PROSE } },
    { [`${'x'.repeat(1030)}`]: PROSE },
    { [`${'x'.repeat(1030)}`]: [PROSE] },
    { [`${'x'.repeat(80)}`]: PROSE },
    { [`${'x'.repeat(60)}`]: PROSE },
    { [`${'x'.repeat(40)}`]: `${PROSE}\nz` },
    { k: [[PROSE]] },
    { k: [{ j: [PROSE] }] },
    { 'a b': { 'c d': PROSE } },
    { k: 'a"b\nc' },
    { k: 'a"b' },
    { 'k"': 1 },
    { "k'": 1 },
    { 'k"\'': 1 },
    { k: 'it\'s "x"' },
    { k: 'x\n\ny' },
    { k: '\n\n\nx\n\n' },
    { k: ' \n x' },
    { k: '\t\nx' },
  ]
}

export function writerCases(count: number): WriterCase[] {
  const d = new Dice(mulberry32(WRITER_SEED))
  const values = [...unsafeValues(), ...branchValues(), ...writerValues(d, count)]
  return values.map(writerCase).filter((c) => JSON.stringify(c).length < 3400 || 'err' in c)
}
