import { stringify } from 'yaml'
import { type Dice, nastyString, writerValue } from '../frontmatter-oracle/corpus.js'
import { AWKWARD, FRAGMENTS, KEYS, STRINGS } from '../frontmatter-oracle/corpus-data.js'

/** The frontmatter objects and bodies the oracle's documents are built from. */
export type Obj = Record<string, unknown>

export const GOOD_ACTORS = [
  'human:alice',
  'agent/1.0',
  'process:nightly',
  'team:ga4-docs',
  'é',
  'x y',
]
export const BAD_ACTORS: unknown[] = [
  '',
  ' x',
  'x ',
  'a\nb',
  'a\rb',
  ' x',
  'x ',
  '﻿x',
  '\u0085x',
  '᠎x',
  'x　',
  ' ',
  5,
  null,
  ['a'],
  { a: 1 },
  true,
]
export const GOOD_TIMES = [
  '2026-01-02T03:04:05Z',
  '2026-01-02T03:04:05.123Z',
  '2026-01-02T03:04:05+09:00',
  '2026-01-02T03:04:05-00:30',
  '0000-00-00T00:00:00Z',
]
export const BAD_TIMES: unknown[] = [
  '2026-01-02',
  '2026-01-02T03:04:05',
  '2026-01-02 03:04:05Z',
  '2026-1-2T03:04:05Z',
  '2026-01-02T03:04:05.Z',
  '2026-01-02T03:04:05z',
  '2026-01-02T03:04:05+0900',
  '2026-01-02T03:04:05Z\n',
  ' 2026-01-02T03:04:05Z',
  '２026-01-02T03:04:05Z',
  '2026-01-02T03:04:05.1.2Z',
  '',
  2026,
  null,
  false,
]
const FACET_KEYS = ['visual.shape/v0', 'a.b/v12', 'x-y.z9/v1', 'plugin.name/v0']
const BAD_FACET_KEYS = [
  'plain',
  'Visual.shape/v0',
  'visual.shape',
  'visual.shape/v',
  'visual.shape/vx',
  'visual.shape/v0\n',
  '1a.b/v0',
  'a.b/v0 ',
  'a..b/v0',
  'é.b/v0',
  '',
  '2',
  '10',
]
/** Root keys the document does not model, including the ones JavaScript enumerates first. */
const UNKNOWN_KEYS = [
  'status',
  'sources',
  'stale_after',
  'x-extra',
  'Type',
  'facetsRaw',
  'constructor',
  'toString',
  '2',
  '10',
  '01',
  '4294967295',
  '4294967294',
  'k',
  'é',
]
const WRONG: unknown[] = [
  5,
  true,
  null,
  [],
  {},
  ['a'],
  { a: 1 },
  1.5,
  '',
  [1, 'a', null],
  { length: 0 },
  { length: 3 },
  { length: '' },
  { length: [5] },
]

const pick = <T>(d: Dice, items: readonly T[]): T => d.pick(items)

function text(d: Dice): string {
  const r = d.int(10)
  if (r < 6) return pick(d, STRINGS)
  if (r < 8) return pick(d, AWKWARD)
  return nastyString(d)
}

function payload(d: Dice): unknown {
  return writerValue(d, 2)
}

function extras(d: Dice): Obj {
  const out: Obj = {}
  for (let i = 0, n = d.int(3); i < n; i++) out[pick(d, KEYS)] = payload(d)
  return out
}

/** A trust event, valid or damaged in one place, with the keys a producer may add. */
export function trustEvent(d: Dice, damage = d.chance(0.3)): unknown {
  const event: Obj = { by: pick(d, GOOD_ACTORS), at: pick(d, GOOD_TIMES) }
  if (damage) {
    const r = d.int(5)
    if (r === 0) event.by = pick(d, BAD_ACTORS)
    else if (r === 1) event.at = pick(d, BAD_TIMES)
    else if (r === 2) delete event.by
    else if (r === 3) delete event.at
    else return pick(d, WRONG)
  }
  return d.chance(0.25) ? { ...extras(d), ...event } : event
}

function verified(d: Dice): unknown {
  const r = d.int(10)
  if (r < 5) return Array.from({ length: d.int(4) }, () => trustEvent(d))
  if (r < 8) return trustEvent(d)
  return d.chance(0.5) ? [trustEvent(d, true), trustEvent(d)] : pick(d, WRONG)
}

function facets(d: Dice): unknown {
  if (d.chance(0.1)) return pick(d, WRONG)
  const entries = Array.from({ length: d.int(4) }, (): [string, unknown] => [
    d.chance(0.8) ? pick(d, FACET_KEYS) : pick(d, BAD_FACET_KEYS),
    payload(d),
  ])
  return Object.fromEntries(entries)
}

function tags(d: Dice): unknown {
  if (d.chance(0.1)) return pick(d, WRONG)
  return Array.from({ length: d.int(4) }, () => (d.chance(0.9) ? text(d) : pick(d, WRONG)))
}

function maybeText(d: Dice): unknown {
  return d.chance(0.9) ? text(d) : pick(d, WRONG)
}

/** Root keys in a random order: the order they are written in decides the order `facetsRaw` keeps them. */
function shuffled(d: Dice, entries: [string, unknown][]): [string, unknown][] {
  const out = [...entries]
  for (let i = out.length - 1; i > 0; i--) {
    const j = d.int(i + 1)
    ;[out[i], out[j]] = [out[j] as [string, unknown], out[i] as [string, unknown]]
  }
  return out
}

/** A frontmatter as a person or a producer might write it: usually valid, damaged in one field now and then. */
export function frontmatter(d: Dice): Obj {
  const entries: [string, unknown][] = []
  if (d.chance(0.93)) entries.push(['type', d.chance(0.92) ? text(d) || 'note' : pick(d, WRONG)])
  for (const key of ['title', 'description', 'resource', 'view']) {
    if (d.chance(0.35)) entries.push([key, maybeText(d)])
  }
  if (d.chance(0.35)) entries.push(['tags', tags(d)])
  if (d.chance(0.22)) entries.push(['generated', trustEvent(d)])
  if (d.chance(0.25)) entries.push(['verified', verified(d)])
  if (d.chance(0.3)) entries.push(['facets', facets(d)])
  for (let i = 0, n = d.chance(0.4) ? 1 + d.int(3) : 0; i < n; i++) {
    entries.push([pick(d, UNKNOWN_KEYS), payload(d)])
  }
  return Object.fromEntries(shuffled(d, entries))
}

/** The YAML for a frontmatter object: block style as `yaml` writes it, or JSON's flow style. */
export function render(value: unknown, d: Dice): string {
  try {
    if (d.chance(0.8)) {
      return stringify(value, { aliasDuplicateObjects: false, doubleQuotedAsJSON: true }).replace(
        /\n$/,
        '',
      )
    }
  } catch {
    // Falls through to JSON: not every value has a block spelling.
  }
  return JSON.stringify(value) ?? 'null'
}

const BODIES = [
  '',
  'body',
  '\n',
  'line one\nline two\n',
  'crlf\r\nbody\r\n',
  '---\nnot frontmatter\n---\n',
  '# Heading\n\n```yaml\n---\na: 1\n---\n```\n',
  'café \u{1f600}   \u0085',
  '\r',
  '﻿bom first',
  '---',
  '\n\n\n',
]

export function body(d: Dice): string {
  if (d.chance(0.6)) return pick(d, BODIES)
  return Array.from({ length: d.int(8) }, () => pick(d, FRAGMENTS)).join('')
}
