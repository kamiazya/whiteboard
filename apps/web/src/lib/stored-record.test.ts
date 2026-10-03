// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  readStoredRecord,
  serializeStoredRecord,
  withoutStoredEntry,
  withStoredEntry,
} from './stored-record.js'

const entry = z.object({ n: z.number() }).strict()

describe('readStoredRecord', () => {
  it('keeps the entries that parse and drops only the ones that do not', () => {
    const raw = JSON.stringify({ a: { n: 1 }, b: { n: 2, fromANewerBuild: true }, c: { n: 3 } })
    expect(readStoredRecord(raw, entry).entries).toEqual({ a: { n: 1 }, c: { n: 3 } })
  })

  it('reads text that is not a JSON object as empty', () => {
    for (const raw of [null, 'not json', '[1,2]', 'null', '7']) {
      expect(readStoredRecord(raw, entry)).toEqual({ entries: {}, unread: {} })
    }
  })

  it('keeps an entry keyed __proto__ as an entry, without touching the prototype', () => {
    const { entries: record } = readStoredRecord('{"__proto__": {"n": 9}}', entry)
    expect(Object.getPrototypeOf(record)).toBe(Object.prototype)
    expect(Object.hasOwn(record, '__proto__')).toBe(true)
    expect(Object.getOwnPropertyDescriptor(record, '__proto__')?.value).toEqual({ n: 9 })
  })
})

describe('a record round-tripped through storage text', () => {
  const raw = JSON.stringify({ a: { n: 1 }, b: { n: 2, fromANewerBuild: true } })

  it('sets the unreadable entry aside as stored, and writes it back', () => {
    const record = readStoredRecord(raw, entry)
    expect(record.unread).toEqual({ b: { n: 2, fromANewerBuild: true } })
    expect(JSON.parse(serializeStoredRecord(record))).toEqual(JSON.parse(raw))
  })

  it('writes an entry over an unreadable one under the same key', () => {
    const record = withStoredEntry(readStoredRecord(raw, entry), 'b', { n: 5 })
    expect(JSON.parse(serializeStoredRecord(record))).toEqual({ a: { n: 1 }, b: { n: 5 } })
  })

  it('removes a key whether its entry was readable or not', () => {
    const record = readStoredRecord(raw, entry)
    expect(JSON.parse(serializeStoredRecord(withoutStoredEntry(record, 'a')))).toEqual({
      b: { n: 2, fromANewerBuild: true },
    })
    expect(JSON.parse(serializeStoredRecord(withoutStoredEntry(record, 'b')))).toEqual({
      a: { n: 1 },
    })
  })
})
