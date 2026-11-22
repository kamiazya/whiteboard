import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { type Answer, type GraphRow, replay } from '../test-utils/graph-oracle.js'

/**
 * The committed recording of what this package's pure judgements answer, taken
 * by `scripts/record-graph-oracle.ts`: the facts a document contributes, where
 * a name is mentioned outside a link, the edit that links mentions, the edit
 * that follows a rename, and the backlinks and mentions a listing answers. The
 * Rust `whiteboard-reference-graph` crate replays it.
 */
const FILE = new URL('./graph-rules.jsonl', import.meta.url)
const INDEX = new URL('../index.ts', import.meta.url)

const HOW_TO_RERECORD =
  'If the change is deliberate, re-record: pnpm --filter @kamiazya/whiteboard-mcp exec tsx ../reference-graph/scripts/record-graph-oracle.ts'

type Row = GraphRow & { id: string; tag: string; result: Answer }

const rows: Row[] = readFileSync(FILE, 'utf8')
  .split('\n')
  .filter((line) => line !== '')
  .map((line) => JSON.parse(line) as Row)

/** Rows each judgement must hold; `refusing` counts the rows that answer with a refusal. */
const FLOORS: Record<string, { rows: number; refusing: number }> = {
  extractContentFacts: { rows: 140, refusing: 0 },
  tagBearersOf: { rows: 25, refusing: 0 },
  splitBearerTags: { rows: 7, refusing: 0 },
  unlinkedNameSpans: { rows: 70, refusing: 0 },
  planLinkifyMentions: { rows: 140, refusing: 2 },
  planDocumentReferenceRewrite: { rows: 250, refusing: 3 },
  backlinksIn: { rows: 60, refusing: 0 },
  breachMessage: { rows: 6, refusing: 0 },
}

/** Exports of the package's entry that are not recorded as a judgement of their own, and why. */
const NOT_RECORDED: Record<string, string> = {
  ContentFactsCache:
    'a cache over a port that loads documents: its answer is when it re-reads, not a function of its input',
  ReferenceRewriteTooLargeError:
    'recorded through breachMessage and the breach each refusal carries',
}

/** Judgements recorded under a name the entry does not export, and where they are reached from. */
const RECORDED_INTERNALS = ['extractContentFacts', 'unlinkedNameSpans']

const isEmpty = (answer: Answer) =>
  'ok' in answer &&
  (answer.ok === null || (Array.isArray(answer.ok) && (answer.ok as unknown[]).length === 0))

describe('the recorded reference-graph oracle', () => {
  it('holds every judgement at its floor', () => {
    const byOp = new Map<string, Row[]>()
    for (const row of rows) byOp.set(row.op, [...(byOp.get(row.op) ?? []), row])
    for (const [op, floor] of Object.entries(FLOORS)) {
      const held = byOp.get(op) ?? []
      expect(held.length, `rows of ${op}`).toBeGreaterThanOrEqual(floor.rows)
      expect(
        held.filter((r) => 'err' in r.result).length,
        `refused rows of ${op}`,
      ).toBeGreaterThanOrEqual(floor.refusing)
    }
    expect(
      [...byOp.keys()].filter((op) => !(op in FLOORS)),
      'rows of a judgement with no floor',
    ).toEqual([])
  })

  it('classifies every value the package exports', () => {
    const names = [...readFileSync(INDEX, 'utf8').matchAll(/export \{([^}]*)\}/g)]
      .flatMap((m) => (m[1] as string).split(','))
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '' && !entry.startsWith('type '))
    expect(names.length, 'exported values found').toBeGreaterThan(5)
    expect(
      names.filter((n) => !(n in FLOORS) && !(n in NOT_RECORDED)),
      'exports neither recorded nor classified',
    ).toEqual([])
    expect(
      Object.keys(NOT_RECORDED).filter((n) => !names.includes(n)),
      'classified exports that are gone',
    ).toEqual([])
    expect(
      RECORDED_INTERNALS.filter((op) => !(op in FLOORS)),
      'internals named here that no row records',
    ).toEqual([])
  })

  it('reaches aliases, headings, CJK and emoji, mentions outside links, both node kinds and growth refusals', () => {
    const text = (row: Row) => JSON.stringify(row)
    const ofOp = (op: string) => rows.filter((r) => r.op === op)
    const nonEmpty = (op: string) => ofOp(op).filter((r) => !isEmpty(r.result)).length
    expect(nonEmpty('unlinkedNameSpans'), 'mentions found').toBeGreaterThan(40)
    expect(
      ofOp('planLinkifyMentions').filter(
        (r) => 'ok' in r.result && (r.result.ok as { linked: number }).linked > 0,
      ).length,
      'linking plans that link',
    ).toBeGreaterThan(30)
    expect(
      ofOp('planLinkifyMentions').filter((r) => r.content?.kind === 'spatial' && !isEmpty(r.result))
        .length,
      'canvas linking plans',
    ).toBeGreaterThan(5)
    expect(
      nonEmpty('planDocumentReferenceRewrite'),
      'rewrites that change a document',
    ).toBeGreaterThan(100)
    expect(
      ofOp('planDocumentReferenceRewrite').filter(
        (r) => r.content?.kind === 'spatial' && !isEmpty(r.result),
      ).length,
      'canvas rewrites',
    ).toBeGreaterThan(2)
    expect(
      ofOp('backlinksIn').filter(
        (r) => (r.result as { ok: { backlinks: unknown[] } }).ok.backlinks.length > 0,
      ).length,
      'listings with a backlink',
    ).toBeGreaterThan(30)
    expect(
      ofOp('backlinksIn').filter(
        (r) => (r.result as { ok: { unlinkedMentions: unknown[] } }).ok.unlinkedMentions.length > 0,
      ).length,
      'listings with an unlinked mention',
    ).toBeGreaterThan(30)
    expect(
      rows.filter((r) => /\|[^\]]*\]\]/.test(text(r))).length,
      'aliased references',
    ).toBeGreaterThan(60)
    expect(
      rows.filter((r) => /\[\[[^\]|]*#/.test(text(r))).length,
      'headed references',
    ).toBeGreaterThan(20)
    expect(rows.filter((r) => /[぀-鿿]/.test(text(r))).length, 'CJK').toBeGreaterThan(40)
    expect(
      rows.filter((r) => /[\u{10000}-\u{10ffff}]/u.test(text(r))).length,
      'astral',
    ).toBeGreaterThan(20)
    const breaches = rows.flatMap((r) =>
      'err' in r.result && r.result.breach !== undefined ? [r.result.breach.shape] : [],
    )
    expect(breaches.filter((shape) => shape === 'body').length, 'body refusals').toBeGreaterThan(1)
    expect(
      breaches.filter((shape) => shape === 'node-text').length,
      'node refusals',
    ).toBeGreaterThan(1)
  })

  // Goes when the TypeScript judgements go: the Rust crate replays the
  // recording against its own answers instead.
  describe('equals what the TypeScript judgements answer today (deleted with the TS)', () => {
    it.each(rows.map((row) => [row.id, row] as const))('%s', (_id, row) => {
      expect(replay(row), `${row.id} ${row.tag}. ${HOW_TO_RERECORD}`).toEqual(row.result)
    })
  })
})
