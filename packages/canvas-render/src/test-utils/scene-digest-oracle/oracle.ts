import { readFileSync } from 'node:fs'
import type { Scene } from '@kamiazya/whiteboard-scene'
import { sceneDigest } from '../../scene-digest.js'
import { CASES } from './corpus.js'
import { mulberry32, type Spec, sceneOfSpec, seededSpec } from './spec.js'

/**
 * What `sceneDigest` answers, recorded as the exact text `JSON.stringify` makes
 * of it, for the Rust port to replay byte for byte (ADR-0054 slice S12).
 *
 * Three kinds of input reach it:
 * - `real`: the scenes the SVG recording already holds (the goldens and every
 *   laid-out canvas), read from `svg.jsonl` by id, so a layout is judged once and
 *   its digest here costs only the answer;
 * - `case`: a scene written as a spec, small enough to hold inline: the arrangements
 *   each guard of the function exists for, and seeded boards drawn once and
 *   committed as data;
 * - `chunk`: thousands of seeded boards regenerated from the `meta` record by
 *   both sides, one FNV digest per chunk of answers, the way the line-break
 *   recording holds its large corpora.
 *
 * A spec names a node by kind, id, box and flags, which is everything the digest
 * reads of one. The digest of a scene the TypeScript cannot answer is `null`: it
 * throws `RangeError` allocating a grid row, which the Rust port answers as an
 * error.
 */

export type OracleRecord =
  | { readonly k: 'meta'; readonly seed: number; readonly chunks: number; readonly per: number }
  | ({ readonly k: 'real'; readonly id: string } & Answer)
  | ({ readonly k: 'case'; readonly id: string; readonly spec: Spec } & Answer)
  | { readonly k: 'chunk'; readonly c: number; readonly n: number; readonly h: number }

/**
 * A digest as recorded: its text, or past `INLINE_LIMIT` characters its length
 * and FNV digest, since a capped free-region list alone runs to 60,000 characters.
 * `d` is `null` where the function throws.
 */
export type Answer = { readonly d: string | null } | { readonly n: number; readonly h: number }

const INLINE_LIMIT = 3000

export const META = { seed: 0x5ce2_ed19, chunks: 60, per: 250 }

/** The digest as `JSON.stringify` writes it, or `null` where the function throws. */
export function digestText(scene: Scene): string | null {
  try {
    return JSON.stringify(sceneDigest(scene))
  } catch (error) {
    if (error instanceof RangeError) return null
    throw error
  }
}

const SVG_RECORDING = new URL('../../oracle/svg.jsonl', import.meta.url)

/** The scenes of the SVG recording, one per distinct scene. */
export function realScenes(): { id: string; scene: Scene }[] {
  return readFileSync(SVG_RECORDING, 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as { id: string; scene: Scene })
    .filter(({ id }) => !/#[123]$/.test(id))
}

class Fnv {
  private state = 0x811c_9dc5

  feed(word: number): void {
    this.state = Math.imul(this.state ^ word, 16_777_619) >>> 0
  }

  get value(): number {
    return this.state
  }
}

/** One chunk's digest: every board's answer text by UTF-16 unit, then a sentinel. */
export function chunkDigest(chunk: number): { n: number; h: number } {
  const next = mulberry32(META.seed + chunk)
  const fnv = new Fnv()
  for (let board = 0; board < META.per; board += 1) {
    const text = digestText(sceneOfSpec(seededSpec(next)))
    if (text === null) fnv.feed(0xffff_fffe)
    else for (let u = 0; u < text.length; u += 1) fnv.feed(text.charCodeAt(u))
    fnv.feed(0xffff_ffff)
  }
  return { n: META.per, h: fnv.value }
}

function fnvOfText(text: string): number {
  const fnv = new Fnv()
  for (let u = 0; u < text.length; u += 1) fnv.feed(text.charCodeAt(u))
  return fnv.value
}

/** What the recording keeps of one scene's digest. */
export function answerOf(scene: Scene): Answer {
  const text = digestText(scene)
  return text === null || text.length <= INLINE_LIMIT
    ? { d: text }
    : { n: text.length, h: fnvOfText(text) }
}

export function recording(): readonly OracleRecord[] {
  const real: OracleRecord[] = realScenes().map(({ id, scene }) => ({
    k: 'real',
    id,
    ...answerOf(scene),
  }))
  const cases: OracleRecord[] = CASES.map(({ id, spec }) => ({
    k: 'case',
    id,
    spec,
    ...answerOf(sceneOfSpec(spec)),
  }))
  const chunks: OracleRecord[] = Array.from({ length: META.chunks }, (_, c) => ({
    k: 'chunk',
    c,
    ...chunkDigest(c),
  }))
  return [{ k: 'meta', ...META }, ...real, ...cases, ...chunks]
}
