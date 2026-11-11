import { readFileSync, writeFileSync } from 'node:fs'
import type { Scene } from '@kamiazya/whiteboard-scene'
import { describe, expect, it } from 'vitest'
import type { sceneDigest } from '../scene-digest.js'
import { decodeLines, encodeLines, type RenderRecord } from '../test-utils/render-oracle/oracle.js'
import {
  type Answer,
  answerOf,
  chunkDigest,
  digestText,
  META,
  type OracleRecord,
  realScenes,
  recording,
} from '../test-utils/scene-digest-oracle/oracle.js'
import { sceneOfSpec } from '../test-utils/scene-digest-oracle/spec.js'

/**
 * The committed recording of what `sceneDigest` answers, as the text
 * `JSON.stringify` makes of it, equals what the TypeScript answers today, and the
 * Rust port replays it byte for byte (`tests/scene_digest_oracle.rs` in
 * `crates/core/canvas-render`). Re-record after a deliberate change with
 * `WHITEBOARD_RECORD_ORACLE=1 pnpm vitest run --project canvas-render-node scene-digest-recorded`.
 */
const FILE = new URL('./scene-digest.jsonl', import.meta.url)
const RENDER = new URL('./render.jsonl', import.meta.url)

if (process.env.WHITEBOARD_RECORD_ORACLE === '1') {
  writeFileSync(FILE, encodeLines(recording()))
}

type Digest = ReturnType<typeof sceneDigest>

describe('the recorded scene digest oracle', () => {
  const recorded = decodeLines<OracleRecord>(readFileSync(FILE, 'utf8'))
  const real = recorded.filter((r) => r.k === 'real')
  const cases = recorded.filter((r) => r.k === 'case')
  const chunks = recorded.filter((r) => r.k === 'chunk')
  const scenes = new Map(realScenes().map((s) => [s.id, s.scene]))
  /** The answer part of a record: what replaces the scene's digest text. */
  const answerPart = (r: Answer): Answer => ('d' in r ? { d: r.d } : { n: r.n, h: r.h })

  it('reaches the real layouts, the guards, the throwing grids and every chunk', () => {
    expect(real.length, 'real scenes').toBeGreaterThan(100)
    expect(cases.length, 'cases').toBeGreaterThan(150)
    expect(chunks).toHaveLength(META.chunks)
    // Judged on the digests themselves: a large one is held as a hash.
    const digests = [
      ...real.map((r) => digestText(scenes.get(r.id) as Scene)),
      ...cases.map((r) => digestText(sceneOfSpec(r.spec))),
    ]
    const answered = digests.flatMap((d) => (d === null ? [] : [JSON.parse(d) as Digest]))
    const any = (keep: (d: Digest) => boolean) => answered.filter(keep).length
    expect(
      any((d) => d.overlaps.length > 0),
      'digests with an overlap',
    ).toBeGreaterThan(40)
    expect(
      any((d) => d.containment.length > 0),
      'digests with a containment',
    ).toBeGreaterThan(30)
    expect(
      any((d) => d.clusters.length > 1),
      'digests with several clusters',
    ).toBeGreaterThan(40)
    expect(
      any((d) => d.freeRegions.length > 0),
      'digests with a free region',
    ).toBeGreaterThan(60)
    expect(
      any((d) => d.partial),
      'partial digests',
    ).toBeGreaterThan(8)
    expect(
      any((d) => d.nodes.some((n) => n.truncated)),
      'a cut node',
    ).toBeGreaterThan(2)
    expect(
      any((d) => d.nodes.some((n) => n.overflows)),
      'an overflowing node',
    ).toBeGreaterThan(2)
    expect(
      any((d) => d.nodes.some((n) => /^n\d+$/.test(n.id))),
      'positional names',
    ).toBeGreaterThan(8)
    expect(
      digests.filter((d) => d === null).length,
      'grids that cannot be allocated',
    ).toBeGreaterThan(3)
    expect(
      recorded.filter((r) => 'h' in r && r.k !== 'chunk').length,
      'digests held as a hash',
    ).toBeGreaterThan(5)
    expect(recorded.filter((r) => r.k === 'meta')).toEqual([{ k: 'meta', ...META }])
  })

  it('equals what the TypeScript answers for the real scenes today', () => {
    expect(real.map((r) => r.id)).toEqual([...scenes.keys()])
    const stale = real.find(
      (r) => JSON.stringify(answerOf(scenes.get(r.id) as Scene)) !== JSON.stringify(answerPart(r)),
    )
    expect(
      stale?.id,
      'the first real scene the TypeScript no longer answers as recorded',
    ).toBeUndefined()
  })

  it('equals what the TypeScript answers for each case today', () => {
    const stale = cases.find(
      (r) => JSON.stringify(answerOf(sceneOfSpec(r.spec))) !== JSON.stringify(answerPart(r)),
    )
    expect(stale?.id, 'the first case the TypeScript no longer answers as recorded').toBeUndefined()
  })

  it('equals what the TypeScript answers for every chunk today', () => {
    const stale = chunks.find((r) => {
      const now = chunkDigest(r.c)
      return now.n !== r.n || now.h !== r.h
    })
    expect(stale?.c, 'the first chunk the TypeScript no longer answers as recorded').toBeUndefined()
  })

  it('agrees with the digest the render recording holds for each laid-out canvas', () => {
    const renders = new Map(
      decodeLines<RenderRecord>(readFileSync(RENDER, 'utf8')).map((r) => [r.id, r.digest]),
    )
    const laid = real.filter((r) => r.id.startsWith('layout/'))
    expect(laid.length).toBeGreaterThan(100)
    const stale = laid.find((r) => {
      const held = JSON.stringify(renders.get(r.id.slice('layout/'.length)))
      return held !== digestText(scenes.get(r.id) as Scene)
    })
    expect(stale?.id, 'the first layout whose digest differs from render.jsonl').toBeUndefined()
  })
})
