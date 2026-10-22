/**
 * A map entry, root container or value key named `__proto__` comes back from
 * every JSON projection as the object's PROTOTYPE rather than as a key, so a
 * reader asking `key in obj` sees keys the map does not hold. No writer here
 * mints one, so the judge both keepers take refuses any update that writes
 * one — the short updates the browser keeper answers without importing
 * included, since a key that size is exactly one such update.
 */
import { LoroDoc, LoroMap } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import {
  importWithinTextLimits,
  judgeStateWithinTextLimits,
  SYNC_TEXT_BREACH_CODES,
  syncTextLimitJudge,
} from './sync-text-limits.js'

/** Past the length the browser keeper answers without importing. */
const PADDING = 'p'.repeat(2_000)

function record(): LoroDoc {
  const doc = new LoroDoc()
  doc.getMap('nodes').set('n1', { id: 'n1', text: 'keep me' })
  doc.getText('body').insert(0, 'hello')
  doc.commit()
  return doc
}

function updateFrom(base: LoroDoc, edit: (doc: LoroDoc) => void, padded: boolean): Uint8Array {
  const client = base.fork()
  const from = client.oplogVersion()
  if (padded) client.getText('body').insert(0, PADDING)
  edit(client)
  client.commit()
  return client.export({ mode: 'update', from })
}

/** Both keepers' verdicts, which must agree. */
function judged(base: LoroDoc, update: Uint8Array) {
  const imported = importWithinTextLimits(base.fork(), update).breach
  expect(syncTextLimitJudge(base)(update)).toEqual(imported)
  return imported
}

const proto = (value: object) => JSON.parse(`{"__proto__":${JSON.stringify(value)},"id":"n2"}`)

const RESERVED: ReadonlyArray<readonly [string, (doc: LoroDoc) => void]> = [
  ['a map entry', (doc) => doc.getMap('nodes').set('__proto__', { id: 'n2' })],
  [
    'a child container',
    (doc) => doc.getMap('nodes').setContainer('__proto__', new LoroMap()).set('nodes', 1),
  ],
  ['a root container', (doc) => doc.getMap('__proto__').set('nodes', { n1: {} })],
  ['a key inside a value', (doc) => doc.getMap('nodes').set('n2', proto({ text: 'x' }))],
  ['a key inside a listed value', (doc) => doc.getList('elements').insert(0, proto({ a: 1 }))],
]

describe('an update writing a `__proto__` key', () => {
  describe.each([
    ['short', false],
    ['long', true],
  ] as const)('%s', (_length, padded) => {
    it.each(RESERVED)('as %s is refused', (_where, edit) => {
      const base = record()

      const breach = judged(base, updateFrom(base, edit, padded))

      expect(breach).toMatchObject({ shape: 'reserved-map-key' })
    })

    it('in text, as words, is let through', () => {
      const base = record()
      const update = updateFrom(base, (doc) => doc.getText('body').insert(0, '__proto__'), padded)

      expect(judged(base, update)).toBeNull()
    })
  })

  it('deleting one a record already holds is let through, which is its repair', () => {
    const base = record()
    base.getMap('nodes').set('__proto__', 1)
    base.commit()

    const update = updateFrom(base, (doc) => doc.getMap('nodes').delete('__proto__'), true)

    expect(judged(base, update)).toBeNull()
  })

  it('a carried record holding one is refused when judged as a state', () => {
    const doc = record()
    doc.getMap('nodes').set('__proto__', 1)
    doc.commit()

    expect(judgeStateWithinTextLimits(doc)).toMatchObject({ shape: 'reserved-map-key' })
  })

  it('is answered with the reserved-key refusal', () => {
    expect(SYNC_TEXT_BREACH_CODES['reserved-map-key']).toBe('reserved_map_key')
  })
})
