import { readFileSync } from 'node:fs'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import {
  autoVersionsOverCap,
  CHECKPOINT_QUIET_MS,
  carriedAutoVersionsOverCap,
  compactionCut,
  frontiersFromBase64,
  frontiersToBase64,
  MAX_AUTO_PER_DOCUMENT,
  MAX_MANUAL_PER_DOCUMENT,
  MAX_RESTORE_POINTS_PER_DOCUMENT,
  restorePointOptions,
  sandwichedAutoVersionIds,
} from '../index.js'
import {
  type Answer,
  answer,
  type FrontierPairs,
  frontiersOfPairs,
  pairsOfFrontiers,
} from '../test-utils/crdt-mechanics-oracle.js'

/**
 * The committed recording of what loro-crdt 1.17.1 and this package's pure
 * judgements answer, taken by `scripts/record-crdt-mechanics-oracle.ts`. The
 * Rust `whiteboard-crdt` crate replays it. It holds the document bytes as well
 * as the answers, so this test needs no generator.
 */
const FILE = new URL('./crdt-mechanics.jsonl', import.meta.url)
const INDEX = new URL('../index.ts', import.meta.url)

interface Row {
  id: string
  op: string
  tag: string
  doc?: string
  points?: FrontierPairs[]
  frontiers?: FrontierPairs
  text?: string
  autos?: Array<{ id: string; restoredFrom: string | null }>
  carried?: string[]
  referenced?: string[]
  cap?: number
  candidates?: Array<{ id: string; restoredFrom: string | null; auto: boolean }>
  restoredFrom?: string
  result: Answer
}

const rows: Row[] = readFileSync(FILE, 'utf8')
  .split('\n')
  .filter((line) => line !== '')
  .map((line) => JSON.parse(line) as Row)

/** Rows each judgement must hold; `refusing` and `empty` count its two non-answers. */
const FLOORS = {
  compactionCut: { rows: 150, answering: 60, refusing: 0, empty: 60 },
  frontiersToBase64: { rows: 15, answering: 15, refusing: 0, empty: 0 },
  frontiersFromBase64: { rows: 25, answering: 15, refusing: 5, empty: 0 },
  autoVersionsOverCap: { rows: 30, answering: 30, refusing: 0, empty: 5 },
  carriedAutoVersionsOverCap: { rows: 30, answering: 30, refusing: 0, empty: 5 },
  sandwichedAutoVersionIds: { rows: 30, answering: 30, refusing: 0, empty: 5 },
  restorePointOptions: { rows: 3, answering: 3, refusing: 0, empty: 0 },
  constants: { rows: 1, answering: 1, refusing: 0, empty: 0 },
} as const

/**
 * Every function `index.ts` exports, classified. A new export must be either a
 * recorded judgement or say why it is not one.
 */
const NOT_RECORDED: Record<string, string> = {
  createCheckpointScheduler:
    'a timer over injected ports: its answer is when it fires, not a function of its input',
}

const isEmpty = (answerOf: Answer) => {
  if ('err' in answerOf) return false
  const value = answerOf.ok
  return value === null || (Array.isArray(value) && value.length === 0)
}

describe('the recorded CRDT mechanics oracle', () => {
  it('holds every judgement at its floor', () => {
    const byOp = new Map<string, Row[]>()
    for (const row of rows) byOp.set(row.op, [...(byOp.get(row.op) ?? []), row])
    for (const [op, floor] of Object.entries(FLOORS)) {
      const held = byOp.get(op) ?? []
      expect(held.length, `rows of ${op}`).toBeGreaterThanOrEqual(floor.rows)
      expect(
        held.filter((r) => 'ok' in r.result).length,
        `answering rows of ${op}`,
      ).toBeGreaterThanOrEqual(floor.answering)
      expect(
        held.filter((r) => 'err' in r.result).length,
        `refused rows of ${op}`,
      ).toBeGreaterThanOrEqual(floor.refusing)
      expect(
        held.filter((r) => isEmpty(r.result)).length,
        `empty rows of ${op}`,
      ).toBeGreaterThanOrEqual(floor.empty)
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
    expect(names.length, 'exported values found').toBeGreaterThan(10)
    const constants = rows.find((r) => r.op === 'constants')
    const recorded = new Set([
      ...Object.keys(FLOORS),
      ...Object.keys((constants?.result as { ok: object }).ok),
    ])
    expect(
      names.filter((n) => !recorded.has(n) && !(n in NOT_RECORDED)),
      'exports neither recorded nor classified',
    ).toEqual([])
    expect(
      Object.keys(NOT_RECORDED).filter((n) => !names.includes(n)),
      'classified exports that are gone',
    ).toEqual([])
  })

  it('reaches shallow roots, merged peers and a cut that moves', () => {
    const cuts = rows.filter((r) => r.op === 'compactionCut')
    expect(
      cuts.filter((r) => r.tag.startsWith('shallow')).length,
      'cuts over a shallow root',
    ).toBeGreaterThan(20)
    expect(
      cuts.filter((r) => (r.points ?? []).some((p) => new Set(p.map(([peer]) => peer)).size >= 2))
        .length,
      'cuts over a point seen by two peers',
    ).toBeGreaterThan(10)
    expect(
      cuts.filter((r) => 'ok' in r.result && r.result.ok !== null).length,
      'cuts that answer',
    ).toBeGreaterThan(60)
  })

  // Goes when the TypeScript judgements go: the Rust crate replays the recording
  // against its own answers instead.
  describe('equals what npm loro-crdt and the TypeScript judgements answer today (deleted with the TS)', () => {
    it.each(rows.map((row) => [row.id, row] as const))('%s', (_id, row) => {
      const sets = (list: readonly string[] | undefined) => new Set(list ?? [])
      const replay = (): unknown => {
        switch (row.op) {
          case 'compactionCut': {
            const doc = new LoroDoc()
            doc.import(new Uint8Array(Buffer.from(row.doc as string, 'base64')))
            const cut = compactionCut(doc, (row.points ?? []).map(frontiersOfPairs))
            return cut === null ? null : pairsOfFrontiers(cut)
          }
          case 'frontiersToBase64':
            return frontiersToBase64(frontiersOfPairs(row.frontiers ?? []))
          case 'frontiersFromBase64':
            return pairsOfFrontiers(frontiersFromBase64(row.text as string))
          case 'autoVersionsOverCap':
            return autoVersionsOverCap(row.autos ?? [], sets(row.referenced), row.cap)
          case 'carriedAutoVersionsOverCap':
            return carriedAutoVersionsOverCap(
              row.autos ?? [],
              sets(row.carried),
              sets(row.referenced),
              row.cap,
            )
          case 'sandwichedAutoVersionIds':
            return sandwichedAutoVersionIds(row.candidates ?? [])
          case 'restorePointOptions':
            return restorePointOptions(row.restoredFrom as string)
          case 'constants':
            return {
              MAX_AUTO_PER_DOCUMENT,
              MAX_MANUAL_PER_DOCUMENT,
              MAX_RESTORE_POINTS_PER_DOCUMENT,
              CHECKPOINT_QUIET_MS,
            }
          default:
            throw new Error(`no replay for ${row.op}`)
        }
      }
      expect(answer(replay)).toEqual(row.result)
    })
  })
})
