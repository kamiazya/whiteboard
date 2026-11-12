import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { uaxSegments } from '../layout/nodes/uax-segments.js'
import {
  type EdgeRecord,
  type JunctionRecord,
  runOps,
} from '../test-utils/text-primitives-oracle/junction.js'
import {
  type DigestRecord,
  type FitRecord,
  fitAnswer,
  type GraphemeRecord,
  graphemeEnds,
  type LongestRecord,
  longestAnswer,
  recording,
  type UaxRecord,
} from '../test-utils/text-primitives-oracle/oracle.js'

/**
 * The committed recording of what the text primitives answer equals what the
 * TypeScript answers today, and the Rust port replays it exactly
 * (`tests/text_primitives_oracle.rs` in `crates/core/canvas-render`). Re-record
 * after a deliberate change with
 * `WHITEBOARD_RECORD_ORACLE=1 pnpm vitest run --project canvas-render-node text-primitives-recorded`.
 */
const FILE = new URL('./text-primitives.jsonl', import.meta.url)

if (process.env.WHITEBOARD_RECORD_ORACLE === '1') {
  writeFileSync(
    FILE,
    `${recording()
      .map((r) => JSON.stringify(r))
      .join('\n')}\n`,
  )
}

type Record = { kind: string }

describe('the recorded text-primitives oracle', () => {
  const text = readFileSync(FILE, 'utf8')
  const lines = text.trimEnd().split('\n')
  const recorded = lines.map((line) => JSON.parse(line) as Record)
  const of = <T extends Record>(kind: string) => recorded.filter((r): r is T => r.kind === kind)
  const fits = of<FitRecord>('fit')
  const digests = of<DigestRecord>('digest')

  it('reaches every primitive over every kind of input', () => {
    expect(of('uax').length).toBeGreaterThan(70)
    expect(of('uaxu').length).toBeGreaterThanOrEqual(8)
    expect(of('grapheme').length).toBeGreaterThan(50)
    expect(of('longest').length).toBeGreaterThan(150)
    expect(fits.length).toBeGreaterThan(900)
    expect(of('edge').length).toBeGreaterThan(100)
    expect(of('junction').length).toBe(153)
    const chunks = (c: string) => digests.filter((r) => r.c === c).length
    expect(chunks('fit-mixed')).toBe(20)
    expect(chunks('longest-sweep')).toBe(65)
    expect(chunks('grapheme-triples')).toBe(60)
    for (const c of ['between', 'conjunct']) {
      expect(chunks(`grapheme-census-${c}`), c).toBe(272)
    }
  })

  it('records fits that are whole, cut, and over the edge', () => {
    expect(fits.filter((r) => !r.tr && !r.ov).length, 'unchanged').toBeGreaterThan(150)
    expect(fits.filter((r) => r.tr && !r.ov).length, 'cut').toBeGreaterThan(300)
    expect(fits.filter((r) => r.ov).length, 'one grapheme over the edge').toBeGreaterThan(50)
  })

  it('records junctions that relocate, refuse to, allow and forbid a break', () => {
    const outs = of<JunctionRecord>('junction').flatMap((r) =>
      r.ops.map((op, i) => [op.o, r.out[i]]),
    )
    const count = (o: string, v: unknown) =>
      outs.filter(([op, out]) => op === o && out === v).length
    expect(count('reloc', true)).toBeGreaterThan(10)
    expect(count('reloc', false)).toBeGreaterThan(10)
    expect(count('breakable', true)).toBeGreaterThan(30)
    expect(count('breakable', false)).toBeGreaterThan(30)
  })

  it('records the corpora the builders produce today', { timeout: 120_000 }, () => {
    const rebuilt = recording().map((r) => JSON.stringify(r))
    const parted = rebuilt.findIndex((line, i) => line !== lines[i])
    expect(
      parted === -1 ? undefined : rebuilt[parted]?.slice(0, 160),
      'the first record the TypeScript no longer answers as recorded',
    ).toBeUndefined()
    expect(rebuilt).toHaveLength(lines.length)
  })

  it('answers each recorded question as the TypeScript does', () => {
    for (const r of of<UaxRecord>('uax')) expect([...uaxSegments(r.t)]).toEqual(r.s)
    for (const r of of<GraphemeRecord>('grapheme')) expect(graphemeEnds(r.t)).toEqual(r.g)
    for (const r of of<LongestRecord>('longest')) {
      expect(longestAnswer(r.limit, r.guess, r.threshold)).toEqual({ p: r.p, r: r.r })
    }
    const fromHex = (h: string) => {
      const view = new DataView(new ArrayBuffer(8))
      view.setBigUint64(0, BigInt(`0x${h}`))
      return view.getFloat64(0)
    }
    for (const r of fits) {
      const { r: kept, tr, ov, w, calls } = fitAnswer(r.t, fromHex(r.f), fromHex(r.s), fromHex(r.m))
      expect({ kept, tr, ov, w, calls }).toEqual({
        kept: r.r,
        tr: r.tr,
        ov: r.ov,
        w: r.w,
        calls: r.calls,
      })
    }
    for (const r of of<JunctionRecord>('junction')) {
      expect(runOps(r.ops)).toEqual({ out: r.out, runs: r.runs, line: r.line })
    }
    expect(of<EdgeRecord>('edge').length).toBeGreaterThan(0)
  })
})
