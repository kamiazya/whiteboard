/**
 * Records `src/oracle/crdt-engine.jsonl`: what `createCrdtEngine` answers, call
 * by call, for the documents the read oracle holds and the writer batches the
 * write oracle holds.
 *
 *   pnpm --filter @kamiazya/whiteboard-mcp exec tsx \
 *     ../loro-adapter/scripts/record-crdt-engine-oracle.ts
 *
 * Three kinds of row, told apart by `op`:
 * - `open`: a document's snapshot bytes, the one input every query row of that
 *   document names (`doc`), with the state those bytes import to.
 * - a query name: one read of one document (`doc`), with the answer or the
 *   class of the refusal exactly as the engine's `read` gave it. A read that
 *   names a document hosted on a workspace tree node carries `args.documentId`.
 * - a writer name: the bytes BEFORE one batch, the batch, the engine's result
 *   (or the class of what it threw), and what the document holds after it.
 *
 * The documents come from `crdt-read.jsonl` and the batches from
 * `crdt-write.jsonl`, which a seeded generator wrote under fixed peers and a
 * pinned clock, so this recording needs no randomness of its own: every handle
 * is opened under a stated peer. Re-take it after either of them is.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { documentEngine as wire } from '@kamiazya/whiteboard-model'
import { LoroDoc } from 'loro-crdt'
import { createCrdtEngine } from '../src/engine/engine.js'
import { frontierPairs, versionPairs } from '../src/test-utils/crdt-read-oracle.js'
import './oracle-recorder-kit.js'

const here = dirname(fileURLToPath(import.meta.url))
const ORACLE = join(here, '..', 'src', 'oracle')
const OUT = join(ORACLE, 'crdt-engine.jsonl')

/** The rows of a recorded file, in order. */
export function recordedRows(name: string): Array<Record<string, any>> {
  return readFileSync(join(ORACLE, name), 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, any>)
}

/** Writer rows kept of each writer: enough to hold applied, refused and thrown outcomes. */
export const WRITES_PER_WRITER = 6
/** Workspace records whose hosted documents are also read. */
export const HOSTED_RECORDS = 8

/** The reads a document hosted on a workspace tree node answers, as the read oracle asks them. */
export const HOSTED_QUERIES = [
  'documentKind',
  'documentContent',
  'documentContentWithTags',
  'spatialCanvas',
  'nodeLocks',
  'edgeLocks',
  'spatialNodeCount',
  'markdownBody',
  'bodyDelta',
  'coreFacets',
  'trustFacets',
  'facets',
  'annotations',
  'commentThreads',
  'threadMessageCounts',
  'threadMarks',
  'proposals',
  'imageRefIds',
  'retiredStoredShape',
  'retiredCommentRows',
] as const satisfies readonly wire.QueryName[]

const PEER = '1'

/** What `doc` holds, as the oracles write it: the deep value, container ids, versions. */
function stateOf(doc: LoroDoc) {
  return {
    deep: doc.toJSON(),
    ids: doc.getDeepValueWithID(),
    vv: versionPairs(doc.oplogVersion()),
    frontiers: frontierPairs(doc.frontiers()),
  }
}

/** A fresh document that imported `bytes`, so every row states what the BYTES say. */
function imported(b64: string): LoroDoc {
  const doc = new LoroDoc()
  doc.import(new Uint8Array(Buffer.from(b64, 'base64')))
  return doc
}

function plainJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

const engine = createCrdtEngine()
const rows: string[] = []
const emit = (row: Record<string, unknown>) => rows.push(JSON.stringify(row))

/**
 * One read of a handle opened for it alone: a read that opens a root container
 * registers it, and the state size and every later deep value then count the
 * empty root, so an answer depends on what the handle was asked before.
 */
async function read(snapshot: string, query: wire.Query) {
  const { handle } = engine.open({ peer: PEER, bytes: snapshot })
  try {
    const { value } = await engine.read({ handle, query })
    return plainJson(value)
  } finally {
    engine.close({ handle })
  }
}

async function recordDocument(id: string, shape: string, snapshot: string, hosted: string[]) {
  emit({
    op: 'open',
    id,
    shape,
    hosted: hosted.length > 0,
    snapshot,
    ...stateOf(imported(snapshot)),
  })
  for (const query of wire.queryNameSchema.options) {
    const result = await read(snapshot, { query })
    emit({ op: query, id: `${id}:${query}`, doc: id, result })
  }
  for (const documentId of hosted) {
    for (const query of HOSTED_QUERIES) {
      const args = { documentId }
      const result = await read(snapshot, { query, args })
      emit({ op: query, id: `${id}:${documentId}:${query}`, doc: id, args, result })
    }
  }
}

/** Rows spread evenly over `items`, so a writer's few rows are not all its first scene. */
function spread<T>(items: readonly T[], count: number): T[] {
  if (items.length <= count) return [...items]
  return Array.from({ length: count }, (_, i) => items[Math.floor((i * items.length) / count)] as T)
}

function recordWrite(row: Record<string, any>) {
  const { handle } = engine.open({ peer: String(row.peer), bytes: row.before })
  const batch = [{ op: row.op, args: row.args }]
  let result: unknown
  try {
    result = { ok: plainJson(engine.write({ handle, batch })) }
  } catch (error) {
    result = { err: error instanceof Error ? error.constructor.name : typeof error }
  }
  const { bytes } = engine.export({ handle, mode: 'snapshot' })
  emit({
    op: row.op,
    id: row.id,
    tag: row.tag,
    peer: String(row.peer),
    before: row.before,
    batch,
    result,
    ...stateOf(imported(bytes as string)),
  })
  engine.close({ handle })
}

const reads = recordedRows('crdt-read.jsonl')
for (const row of reads.filter((r) => r.host === 'document')) {
  await recordDocument(row.id, row.shape, row.snapshot, [])
}
for (const row of spread(
  reads.filter((r) => r.host === 'workspace' && r.shape === 'ws-hosted-content'),
  HOSTED_RECORDS,
)) {
  const hosted = Object.keys(row.readers.perDocument as object).filter((key) => !key.includes('#'))
  await recordDocument(row.id, row.shape, row.snapshot, hosted)
}

const writes = recordedRows('crdt-write.jsonl').filter((r) => r.op !== 'minimalChange')
const ops = [...new Set(writes.map((r) => r.op as string))]
for (const op of ops) {
  for (const row of spread(
    writes.filter((r) => r.op === op),
    WRITES_PER_WRITER,
  )) {
    recordWrite(row)
  }
}

writeFileSync(OUT, `${rows.join('\n')}\n`)
console.log(`wrote ${rows.length} rows to ${OUT}`)
