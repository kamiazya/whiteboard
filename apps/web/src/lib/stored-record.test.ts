// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { readStoredRecord } from './stored-record.js'

const entry = z.object({ n: z.number() }).strict()

describe('readStoredRecord', () => {
  it('keeps the entries that parse and drops only the ones that do not', () => {
    const raw = JSON.stringify({ a: { n: 1 }, b: { n: 2, fromANewerBuild: true }, c: { n: 3 } })
    expect(readStoredRecord(raw, entry)).toEqual({ a: { n: 1 }, c: { n: 3 } })
  })

  it('reads text that is not a JSON object as empty', () => {
    for (const raw of [null, 'not json', '[1,2]', 'null', '7']) {
      expect(readStoredRecord(raw, entry)).toEqual({})
    }
  })

  it('keeps an entry keyed __proto__ as an entry, without touching the prototype', () => {
    const record = readStoredRecord('{"__proto__": {"n": 9}}', entry)
    expect(Object.getPrototypeOf(record)).toBe(Object.prototype)
    expect(Object.hasOwn(record, '__proto__')).toBe(true)
    expect(Object.getOwnPropertyDescriptor(record, '__proto__')?.value).toEqual({ n: 9 })
  })
})
