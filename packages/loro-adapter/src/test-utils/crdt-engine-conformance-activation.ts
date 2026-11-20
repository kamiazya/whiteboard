/**
 * The conformance cases for a judged import that activates parked operations.
 * An update that builds on operations the document lacks is parked outside the
 * oplog, where no judge reads it, and applies the moment a later import
 * supplies what it builds on. A judged import therefore answers for what it
 * activates too, and a refusal leaves the document exactly as it was, the
 * parked operations still parked.
 */
import { LABEL_MAX_CHARS, MARKDOWN_MAX_CHARS } from '@kamiazya/whiteboard-model'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import type { CrdtEngine } from '../engine/types.js'
import { applied, bodyOf, mutation } from './crdt-engine-conformance-kit.js'
import { documentNode, NOTE, seedRecord } from './crdt-engine-conformance-workspace-sync.js'

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')

/** Two changes by one client to `base`, the second built on the first: what a peer sent out of order delivers. */
function twoChanges(
  base: LoroDoc,
  first: (client: LoroDoc) => void,
  second: (client: LoroDoc) => void,
): { readonly gap: string; readonly gapped: string } {
  const client = base.fork()
  const from = client.oplogVersion()
  first(client)
  client.commit()
  const gap = base64(client.export({ mode: 'update', from }))
  const between = client.oplogVersion()
  second(client)
  client.commit()
  return { gap, gapped: base64(client.export({ mode: 'update', from: between })) }
}

function seededBody(): LoroDoc {
  const doc = new LoroDoc()
  doc.getText('body').insert(0, 'short')
  doc.commit()
  return doc
}

const bodyEdits = (base: LoroDoc, second: string) =>
  twoChanges(
    base,
    (client) => client.getText('body').insert(0, 'gap '),
    (client) => client.getText('body').insert(0, second),
  )

function hold(record: LoroDoc, makeEngine: () => CrdtEngine, updates?: string[]) {
  const engine = makeEngine()
  const { handle } = engine.open({
    peer: '1',
    bytes: base64(record.export({ mode: 'snapshot' })),
    ...(updates === undefined ? {} : { updates }),
  })
  return { engine, handle }
}

function describeActivationJudgingPart1(makeEngine: () => CrdtEngine) {
  it('refuses an update whose activation breaks a text limit, and keeps the document as it was', async () => {
    const base = seededBody()
    const { gap, gapped } = bodyEdits(base, 'x'.repeat(MARKDOWN_MAX_CHARS + 1))
    const { engine, handle } = hold(base, makeEngine)
    expect(applied(engine.import({ handle, bytes: gapped, judge: 'text' })).pending).toBe(true)
    const before = engine.version({ handle })

    const result = mutation(engine.import({ handle, bytes: gap, judge: 'text' }))

    expect(result).toMatchObject({ outcome: 'refused', breach: { shape: 'run' } })
    expect(engine.version({ handle })).toEqual(before)
    expect(await bodyOf(engine, handle)).toBe('short')
  })

  it('keeps the parked operations parked through that refusal, so an unjudged import still completes them', async () => {
    const base = seededBody()
    const { gap, gapped } = bodyEdits(base, 'x'.repeat(MARKDOWN_MAX_CHARS + 1))
    const { engine, handle } = hold(base, makeEngine)
    engine.import({ handle, bytes: gapped, judge: 'text' })
    expect(mutation(engine.import({ handle, bytes: gap, judge: 'text' })).outcome).toBe('refused')

    expect(applied(engine.import({ handle, bytes: gap, judge: 'none' })).pending).toBe(false)
    expect((await bodyOf(engine, handle)).length).toBe(
      'gap '.length + MARKDOWN_MAX_CHARS + 1 + 'short'.length,
    )
  })
}

function describeActivationJudgingPart2(makeEngine: () => CrdtEngine) {
  it('answers for the activation of an update too short to carry a limit of its own', () => {
    // Shorter than any bound a value could break: answered unread when nothing is parked.
    const base = seededBody()
    const { gap, gapped } = twoChanges(
      base,
      (client) => client.getText('body').insert(0, 'g'),
      (client) =>
        client.getText('body').insert(0, 'x'.repeat(LABEL_MAX_CHARS * 4 + MARKDOWN_MAX_CHARS)),
    )
    const { engine, handle } = hold(base, makeEngine)
    engine.import({ handle, bytes: gapped, judge: 'text' })
    expect(mutation(engine.import({ handle, bytes: gap, judge: 'text' })).outcome).toBe('refused')
  })

  it('takes an update whose activation breaks no limit, and applies both', async () => {
    const base = seededBody()
    const { gap, gapped } = bodyEdits(base, 'later ')
    const { engine, handle } = hold(base, makeEngine)
    expect(applied(engine.import({ handle, bytes: gapped, judge: 'text' })).pending).toBe(true)
    expect(applied(engine.import({ handle, bytes: gap, judge: 'text' })).pending).toBe(false)
    expect(await bodyOf(engine, handle)).toBe('later gap short')
  })
}

function describeActivationJudgingPart3(makeEngine: () => CrdtEngine) {
  it('judges later imports as before once what was parked has been applied', async () => {
    const base = seededBody()
    const { gap, gapped } = bodyEdits(base, 'later ')
    const { engine, handle } = hold(base, makeEngine)
    engine.import({ handle, bytes: gapped, judge: 'text' })
    engine.import({ handle, bytes: gap, judge: 'text' })
    const long = base64(
      (() => {
        const client = new LoroDoc()
        client.setPeerId(9n)
        client.getText('body').insert(0, 'x'.repeat(MARKDOWN_MAX_CHARS + 1))
        client.commit()
        return client.export({ mode: 'update' })
      })(),
    )
    expect(mutation(engine.import({ handle, bytes: long, judge: 'text' }))).toMatchObject({
      outcome: 'refused',
      breach: { shape: 'run' },
    })
    expect(await bodyOf(engine, handle)).toBe('later gap short')
  })
}

function describeActivationJudgingPart4(makeEngine: () => CrdtEngine) {
  it('answers for what a workspace record activates, whichever way it was parked', () => {
    const record = seedRecord()
    const { gap, gapped } = twoChanges(
      record,
      (client) => documentNode(client, NOTE).data.set('name', 'one'),
      (client) => documentNode(client, NOTE).data.set('segment', 'not a segment'),
    )
    for (const parkedBy of ['import', 'open'] as const) {
      const { engine, handle } = hold(
        record,
        makeEngine,
        parkedBy === 'open' ? [gapped] : undefined,
      )
      if (parkedBy === 'import') {
        expect(applied(engine.import({ handle, bytes: gapped, judge: 'none' })).pending).toBe(true)
      }
      const before = engine.version({ handle })
      expect(
        mutation(engine.import({ handle, bytes: gap, judge: 'workspace-sync' })),
        parkedBy,
      ).toMatchObject({ outcome: 'refused', breach: { shape: 'invalid-path' } })
      expect(engine.version({ handle }), parkedBy).toEqual(before)
    }
  })
}

export function describeActivationJudging(makeEngine: () => CrdtEngine) {
  describe('an import that activates parked operations', () => {
    describeActivationJudgingPart1(makeEngine)
    describeActivationJudgingPart2(makeEngine)
    describeActivationJudgingPart3(makeEngine)
    describeActivationJudgingPart4(makeEngine)
  })
}
