import type { TextRunNode } from '@kamiazya/whiteboard-scene'
import {
  createInlineJunction,
  headCharacter,
  tailCharacter,
} from '../../layout/nodes/inline-junction.js'
import { mulberry32 } from '../linebreak-oracle/oracle.js'
import { f64Hex } from '../render-oracle/scene-dump.js'

/**
 * The inline junction's recorded answers: head and tail characters over a
 * corpus of texts, and seeded sequences of its operations with every answer and
 * the final position of every run. A sequence is raw operations rather than a
 * wrapper's behaviour, so the junction is held on its own.
 */

const LINE_HEIGHT = 20
const SEQUENCES = { seed: 0x1a7c_0001, count: 150 }

type Paint = 'icon' | 'image'
export type Op =
  | { o: 'push'; t: string; p?: Paint; w: number }
  | { o: 'placed'; t: string; p?: Paint }
  | { o: 'breakable'; t: string; p?: Paint }
  | { o: 'head'; t: string; p?: Paint }
  | { o: 'tail'; t: string; p?: Paint }
  | { o: 'allow' }
  | { o: 'start' }
  | { o: 'reloc' }

export interface EdgeRecord {
  kind: 'edge'
  t: string
  p?: Paint
  head: string
  tail: string
}

export interface JunctionRecord {
  kind: 'junction'
  ops: Op[]
  out: (boolean | string | null)[]
  runs: [string, string][]
  line: { x: string; index: number }
}

const paints = (p: Paint | undefined): TextRunNode['paints'] =>
  p === 'icon'
    ? { kind: 'icon', name: 'star' }
    : p === 'image'
      ? { kind: 'image', src: 'a.png' }
      : undefined

/** Run texts by what they do at a break: closers, openers, spaces, joiners, words. */
const RUN_TEXTS: readonly string[] = [
  'abc',
  't',
  '。',
  '、',
  '「',
  '」',
  '（',
  '）',
  ' ',
  'a ',
  ' a',
  '',
  '日本',
  'code',
  '(',
  ')',
  '-',
  '/',
  '🇯🇵',
  '́',
  'a ',
  '　',
  '﻿',
  '\u0085',
  ' ',
  '𝟙',
  '。。',
  'ー',
  '…',
  '‍',
]

const PAINTS: readonly (Paint | undefined)[] = [undefined, undefined, undefined, 'icon', 'image']
const WIDTHS: readonly number[] = [0, 7, 10.5, 14, 21.25]

export function edgeRecords(): EdgeRecord[] {
  const records: EdgeRecord[] = []
  for (const t of RUN_TEXTS) {
    for (const p of PAINTS) {
      const record: EdgeRecord = {
        kind: 'edge',
        t,
        head: headCharacter(t, paints(p)),
        tail: tailCharacter(t, paints(p)),
        ...(p === undefined ? {} : { p }),
      }
      records.push(record)
    }
  }
  return records
}

/** Applies `ops` to a fresh junction, answering what each returned and where things ended. */
export function runOps(ops: readonly Op[]): Omit<JunctionRecord, 'kind' | 'ops'> {
  const runs: TextRunNode[] & TextRunNode[] = []
  const line = { x: 0, index: 0 }
  const junction = createInlineJunction(runs, line, LINE_HEIGHT)
  const out: (boolean | string | null)[] = []
  for (const op of ops) {
    switch (op.o) {
      case 'push':
        runs.push({
          kind: 'textRun',
          bbox: { x: line.x, y: line.index * LINE_HEIGHT, w: op.w, h: LINE_HEIGHT },
          baseline: 16,
          text: op.t,
          ...(op.p === undefined ? {} : { paints: paints(op.p) }),
        })
        line.x += op.w
        out.push(null)
        break
      case 'placed':
        junction.placed(op.t, paints(op.p))
        out.push(null)
        break
      case 'breakable':
        out.push(junction.breakableBefore(headCharacter(op.t, paints(op.p))))
        break
      case 'head':
        out.push(headCharacter(op.t, paints(op.p)))
        break
      case 'tail':
        out.push(tailCharacter(op.t, paints(op.p)))
        break
      case 'allow':
        junction.allowBreakHere()
        out.push(null)
        break
      case 'start':
        junction.startLine()
        out.push(null)
        break
      case 'reloc':
        out.push(junction.relocateCluster())
        break
    }
  }
  return {
    out,
    runs: runs.map((r) => [f64Hex(r.bbox.x), f64Hex(r.bbox.y)]),
    line: { x: f64Hex(line.x), index: line.index },
  }
}

/** Sequences that read the way a wrapper drives it, and ones that do not. */
function sequences(): Op[][] {
  const next = mulberry32(SEQUENCES.seed)
  const pick = <T>(list: readonly T[]): T => list[next() % list.length] as T
  const run = () => ({ t: pick(RUN_TEXTS), ...optionalPaint(pick(PAINTS)) })
  const all: Op[][] = []
  for (let i = 0; i < SEQUENCES.count; i += 1) {
    const ops: Op[] = []
    const length = 4 + (next() % 12)
    while (ops.length < length) {
      const roll = next() % 100
      const r = run()
      if (roll < 40) ops.push({ o: 'push', ...r, w: pick(WIDTHS) }, { o: 'placed', ...r })
      else if (roll < 60) ops.push({ o: 'breakable', ...r })
      else if (roll < 68) ops.push({ o: 'start' })
      else if (roll < 78) ops.push({ o: 'reloc' })
      else if (roll < 83) ops.push({ o: 'allow' })
      else if (roll < 88) ops.push({ o: 'placed', ...r })
      else if (roll < 93) ops.push({ o: 'push', ...r, w: pick(WIDTHS) })
      else if (roll < 97) ops.push({ o: 'head', ...r })
      else ops.push({ o: 'tail', ...r })
    }
    all.push(ops)
  }
  return all
}

const optionalPaint = (p: Paint | undefined): { p?: Paint } => (p === undefined ? {} : { p })

/** A closing mark after an inline node, as the wrapper meets it, pinned by hand. */
const SCRIPTED: readonly Op[][] = [
  [
    { o: 'push', t: 'abc', w: 21 },
    { o: 'placed', t: 'abc' },
    { o: 'push', t: 'code', w: 28 },
    { o: 'placed', t: 'code' },
    { o: 'breakable', t: '。' },
    { o: 'reloc' },
    { o: 'push', t: '。', w: 14 },
    { o: 'placed', t: '。' },
  ],
  [
    { o: 'push', t: 'abc ', w: 28 },
    { o: 'placed', t: 'abc ' },
    { o: 'breakable', t: '。' },
    { o: 'reloc' },
  ],
  [
    { o: 'push', t: ' ', w: 10, p: 'icon' },
    { o: 'placed', t: ' ', p: 'icon' },
    { o: 'breakable', t: '。' },
    { o: 'breakable', t: 'a' },
    { o: 'reloc' },
    { o: 'start' },
    { o: 'reloc' },
  ],
]

export function junctionRecords(): JunctionRecord[] {
  return [...SCRIPTED, ...sequences()].map((ops) => ({ kind: 'junction', ops, ...runOps(ops) }))
}
