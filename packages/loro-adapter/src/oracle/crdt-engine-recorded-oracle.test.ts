import { readFileSync } from 'node:fs'
import { documentEngine as wire } from '@kamiazya/whiteboard-model'
import { LoroDoc } from 'loro-crdt'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createCrdtEngine } from '../engine/engine.js'
import { frontierPairs, versionPairs } from '../test-utils/crdt-read-oracle.js'
import { RECORDED_NOW } from '../test-utils/crdt-write-oracle.js'

/**
 * The committed recording of what `createCrdtEngine` answers, taken by
 * `scripts/record-crdt-engine-oracle.ts`. The Rust `whiteboard-crdt` crate
 * replays it, so this test holds that the recording is what the engine answers
 * today and that it reaches every query and every writer the contract names.
 */
const rows = readFileSync(new URL('./crdt-engine.jsonl', import.meta.url), 'utf8')
  .split('\n')
  .filter((line) => line !== '')
  .map((line) => JSON.parse(line) as Record<string, any>)

const PEER = '1'
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const imported = (b64: string) => {
  const doc = new LoroDoc()
  doc.import(new Uint8Array(Buffer.from(b64, 'base64')))
  return doc
}

describe('the recorded CRDT engine oracle', () => {
  it('names every query and every writer of the contract, each more than once where it can', () => {
    const counts = new Map<string, number>()
    for (const row of rows) counts.set(row.op, (counts.get(row.op) ?? 0) + 1)
    for (const name of [...wire.queryNameSchema.options, ...wire.writerNameSchema.options]) {
      expect(counts.get(name) ?? 0, `rows of ${name}`).toBeGreaterThanOrEqual(4)
    }
    expect(counts.get('open') ?? 0, 'documents').toBeGreaterThan(150)
    expect(rows.length, 'recorded rows').toBeGreaterThan(5000)
  })

  it('reaches documents of both kinds, hosted and standalone, and the refusals a retired shape is', () => {
    const answers = (op: string) =>
      rows.filter((r) => r.op === op && r.doc !== undefined).map((r) => r.result)
    const kinds = new Set(answers('documentKind').map((a) => JSON.stringify(a)))
    expect(kinds).toContain(JSON.stringify({ ok: 'markdown' }))
    expect(kinds).toContain(JSON.stringify({ ok: 'spatial' }))
    expect(kinds).toContain(JSON.stringify({ ok: { $undefined: true } }))
    expect(
      rows.filter((r) => r.args?.documentId !== undefined).length,
      'hosted reads',
    ).toBeGreaterThan(100)
    expect(
      answers('markdownBody').filter((a) => 'err' in a).length,
      'refused bodies',
    ).toBeGreaterThan(0)
    expect(
      answers('retiredStoredShape').filter((a) => typeof a.ok === 'string').length,
      'retired shapes named',
    ).toBeGreaterThan(5)
    expect(
      answers('bodyDelta').filter((a) => JSON.stringify(a).includes('attributes')).length,
      'bodies carrying marks',
    ).toBeGreaterThan(10)
    expect(
      answers('nodeLocks').filter((a) => a.ok.length > 0).length,
      'locked nodes',
    ).toBeGreaterThan(0)
    expect(
      rows.filter((r) => r.op === 'open' && r.vv.length >= 2).length,
      'documents merged from two peers',
    ).toBeGreaterThan(10)
  })

  // Goes when the TypeScript engine goes: the Rust crate replays the recording instead.
  describe('equals what the TypeScript engine answers today (deleted with the TS)', () => {
    const engine = createCrdtEngine()
    // A commit stamps its time into the update the write exports.
    beforeAll(() => {
      vi.spyOn(Date, 'now').mockReturnValue(RECORDED_NOW)
    })
    afterAll(() => {
      vi.restoreAllMocks()
    })
    const snapshots = new Map<string, string>()
    for (const row of rows) if (row.op === 'open') snapshots.set(row.id, row.snapshot)

    it.each(rows.map((row) => [row.id, row] as const))('%s', async (_id, row) => {
      if (row.op === 'open') {
        const doc = imported(row.snapshot)
        expect(doc.toJSON()).toEqual(row.deep)
        expect(doc.getDeepValueWithID()).toEqual(row.ids)
        expect(versionPairs(doc.oplogVersion())).toEqual(row.vv)
        expect(frontierPairs(doc.frontiers())).toEqual(row.frontiers)
      } else if (row.doc !== undefined) {
        const { handle } = engine.open({ peer: PEER, bytes: snapshots.get(row.doc) })
        const { value } = await engine.read({
          handle,
          query: { query: row.op, ...(row.args === undefined ? {} : { args: row.args }) },
        })
        engine.close({ handle })
        expect(plain(value)).toEqual(row.result)
      } else {
        const { handle } = engine.open({ peer: row.peer, bytes: row.before })
        let result: unknown
        try {
          result = { ok: plain(engine.write({ handle, batch: row.batch })) }
        } catch (error) {
          result = { err: error instanceof Error ? error.constructor.name : typeof error }
        }
        expect(result).toEqual(row.result)
        const { bytes } = engine.export({ handle, mode: 'snapshot' })
        engine.close({ handle })
        const after = imported(bytes as string)
        expect(after.toJSON()).toEqual(row.deep)
        expect(after.getDeepValueWithID()).toEqual(row.ids)
        expect(versionPairs(after.oplogVersion())).toEqual(row.vv)
        expect(frontierPairs(after.frontiers())).toEqual(row.frontiers)
      }
    })
  })
})
