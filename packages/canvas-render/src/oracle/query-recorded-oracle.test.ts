import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { type EdgesRecord, edgesAnswer, edgesInputs } from '../test-utils/query-oracle/edges.js'
import {
  type LabelPlacementRecord,
  labelPlacementAnswer,
  labelPlacementRecords,
} from '../test-utils/query-oracle/label-placement.js'
import {
  type NodeSizeInput,
  type NodeSizeRecord,
  nodeSizeAnswer,
  nodeSizeInputs,
} from '../test-utils/query-oracle/node-size.js'
import {
  type OutlineContentBoxRecord,
  outlineContentBoxAnswer,
  outlineContentBoxRecords,
} from '../test-utils/query-oracle/outline-content-box.js'

/**
 * The committed recordings of the layout pieces the web and the daemon call
 * directly rather than through a whole layout (ADR-0054 step 7, S18a), so the
 * core's query entry is held to them once the TypeScript is deleted:
 *
 * - `layout-spatial-edges.jsonl`: the drag layers' edge-only layout;
 * - `node-size.jsonl`: `fittedTextNodeHeight` and `naturalNodeContentSize`;
 * - `edge-label-placement.jsonl`: `edgeLabelPlacement` with the obstacles
 *   `labelObstacles` and `frameTitleObstacles` answer;
 * - `outline-content-box.jsonl`: `outlineContentBox`.
 *
 * `placeCommentBubble`, the compose bubble's placement, is already recorded
 * with every input it takes in `comment-placement.jsonl`.
 *
 * Each record holds its inputs, so the freshness checks read no corpus.
 * Re-record after a deliberate change with
 * `WHITEBOARD_RECORD_ORACLE=1 pnpm vitest run --project canvas-render-node query-recorded`.
 */
const RECORD = process.env.WHITEBOARD_RECORD_ORACLE === '1'

function recording<T>(name: string, fresh: () => readonly T[]) {
  const file = new URL(`./${name}.jsonl`, import.meta.url)
  if (RECORD)
    writeFileSync(
      file,
      `${fresh()
        .map((r) => JSON.stringify(r))
        .join('\n')}\n`,
    )
  const lines = readFileSync(file, 'utf8').trimEnd().split('\n')
  return { lines, records: lines.map((line) => JSON.parse(line) as T) }
}

/** The id of the first record whose re-computed answer is not the recorded line. */
function firstMoved<T>(
  { lines, records }: { lines: string[]; records: T[] },
  answer: (record: T) => unknown,
  name: (record: T, i: number) => string,
): string | undefined {
  const parted = records.findIndex((r, i) => JSON.stringify(answer(r)) !== lines[i])
  return parted === -1 ? undefined : name(records[parted] as T, parted)
}

describe('the recorded drag-frame edge layer', () => {
  const file = recording<EdgesRecord>('layout-spatial-edges', () => edgesInputs().map(edgesAnswer))

  it('reaches every corpus, both override kinds, labels and the library', () => {
    const ids = file.records.map((r) => r.id)
    for (const prefix of ['hand/', 'composer/', 'drawing/', 'routing/'])
      expect(ids.filter((id) => id.startsWith(prefix)).length, prefix).toBeGreaterThan(4)
    expect(ids.filter((id) => id.endsWith('/cached')).length).toBe(ids.length / 2)
    const answers = file.records.map((r) => r.answer).join('\n')
    for (const part of [
      '"kind":"edge"',
      '"kind":"textRun"',
      '"jumps"',
      '"rounded":true',
      '"style":"sketch"',
    ])
      expect(answers.includes(part), part).toBe(true)
    expect(file.records.some((r) => r.overrides.some(([, o]) => o.from !== undefined))).toBe(true)
    expect(file.records.some((r) => r.profile.library === true)).toBe(true)
  })

  it('equals what the TypeScript answers today', () => {
    const moved = firstMoved(
      file,
      ({ answer: _, ...input }) => edgesAnswer(input),
      (r) => r.id,
    )
    expect(moved, 'the first frame the TypeScript no longer answers as recorded').toBeUndefined()
  })
})

describe('the recorded node sizes', () => {
  const file = recording<NodeSizeRecord>('node-size', () => nodeSizeInputs().map(nodeSizeAnswer))

  it('reaches both queries, both floors, the silhouettes and a fragment table', () => {
    const ids = file.records.map((r) => r.id)
    expect(ids.filter((id) => id.startsWith('fitted/')).length).toBeGreaterThan(60)
    expect(ids.filter((id) => id.startsWith('natural/')).length).toBeGreaterThan(60)
    expect(ids.filter((id) => id.includes('shape visual.')).length).toBeGreaterThan(8)
    // The floor and the fragment table each change some answer.
    const byId = new Map(file.records.map((r) => [r.id, r.answer.join()]))
    expect(
      ids.some(
        (id) => id.endsWith('/ratio') && byId.get(id) !== byId.get(id.replace(/ratio$/, 'none')),
      ),
    ).toBe(true)
  })

  it('equals what the TypeScript answers today', () => {
    const moved = firstMoved(
      file,
      ({ answer: _, ...input }) => nodeSizeAnswer(input as NodeSizeInput),
      (r) => r.id,
    )
    expect(moved, 'the first size the TypeScript no longer answers as recorded').toBeUndefined()
  })
})

describe('the recorded edge label placements', () => {
  const file = recording<LabelPlacementRecord>('edge-label-placement', labelPlacementRecords)

  it('reaches the boards, frame titles, slides and the hand-written edges', () => {
    const placed = file.records.flatMap((r) => (r.kind === 'place' ? [r] : []))
    expect(placed.length).toBeGreaterThan(200)
    expect(placed.filter((r) => r.answer === null).length, 'no place for a label').toBeGreaterThan(
      1,
    )
    expect(placed.filter((r) => r.rounded).length).toBeGreaterThan(50)
    const titled = file.records.filter((r) => r.kind === 'obstacles' && r.titles.length > 0)
    expect(titled.length, 'boards with a frame title').toBeGreaterThan(2)
    expect(placed.filter((r) => r.id.startsWith('hand/')).length).toBeGreaterThan(10)
  })

  it('equals what the TypeScript answers today', () => {
    const moved = firstMoved(file, labelPlacementAnswer, (r) => r.id)
    expect(
      moved,
      'the first placement the TypeScript no longer answers as recorded',
    ).toBeUndefined()
  })
})

describe('the recorded outline content boxes', () => {
  const file = recording<OutlineContentBoxRecord>('outline-content-box', outlineContentBoxRecords)

  it('reaches every silhouette, and some box that is not its own content box', () => {
    expect(new Set(file.records.map((r) => r.shape)).size).toBeGreaterThan(8)
    expect(file.records.some((r) => r.answer.join() !== r.box.join())).toBe(true)
  })

  it('equals what the TypeScript answers today', () => {
    const moved = firstMoved(file, outlineContentBoxAnswer, (r, i) => `${r.shape}#${i}`)
    expect(moved, 'the first box the TypeScript no longer answers as recorded').toBeUndefined()
  })
})
