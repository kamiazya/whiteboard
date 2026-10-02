import { describe, expect, it } from 'vitest'
import { compareToLedger, parseDiagnostics, ratchetLedger } from './typecheck-tests-lib.mjs'

const OUTPUT = [
  "src/a.test.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.",
  "  Type 'string' is not assignable to type 'number'.",
  "src/a.test.ts(9,1): error TS2345: Argument of type 'x' is not assignable.",
  'src\\b.test.ts(1,1): error TS2304: Cannot find name y.',
  "error TS5083: Cannot read file 'tsconfig.nope.json'.",
].join('\n')

describe('parseDiagnostics', () => {
  it('counts errors per file and ignores the continuation lines under them', () => {
    const { byFile } = parseDiagnostics(OUTPUT)
    expect(Object.fromEntries(byFile)).toEqual({ 'src/a.test.ts': 2, 'src/b.test.ts': 1 })
  })

  it('returns an error that names no file apart, since a ledger cannot excuse a program that never ran', () => {
    expect(parseDiagnostics(OUTPUT).unattributed).toEqual([
      "error TS5083: Cannot read file 'tsconfig.nope.json'.",
    ])
  })
})

describe('compareToLedger', () => {
  const actual = new Map([
    ['src/a.test.ts', 2],
    ['src/b.test.ts', 1],
  ])

  it('passes when the actual counts are exactly the ledger', () => {
    expect(compareToLedger(actual, { 'src/a.test.ts': 2, 'src/b.test.ts': 1 }).failed).toBe(false)
  })

  it('fails on an error in a file the ledger does not name', () => {
    const verdict = compareToLedger(actual, { 'src/a.test.ts': 2 })
    expect(verdict.failed).toBe(true)
    expect(verdict.added).toEqual([{ file: 'src/b.test.ts', count: 1 }])
  })

  it('fails when a ledgered file gained an error', () => {
    const verdict = compareToLedger(actual, { 'src/a.test.ts': 1, 'src/b.test.ts': 1 })
    expect(verdict.failed).toBe(true)
    expect(verdict.grew).toEqual([{ file: 'src/a.test.ts', count: 2, recorded: 1 }])
  })

  it('fails when a ledgered file carries fewer errors than recorded, so the record follows the repair', () => {
    const verdict = compareToLedger(actual, { 'src/a.test.ts': 5, 'src/b.test.ts': 1 })
    expect(verdict.failed).toBe(true)
    expect(verdict.shrunk).toEqual([{ file: 'src/a.test.ts', count: 2, recorded: 5 }])
  })

  it('fails when a ledgered file has no errors left at all', () => {
    const verdict = compareToLedger(actual, {
      'src/a.test.ts': 2,
      'src/b.test.ts': 1,
      'src/c.test.ts': 4,
    })
    expect(verdict.failed).toBe(true)
    expect(verdict.cleared).toEqual([{ file: 'src/c.test.ts', recorded: 4 }])
  })
})

describe('ratchetLedger', () => {
  it('records paid-down debt', () => {
    const result = ratchetLedger(new Map([['src/a.test.ts', 1]]), {
      'src/a.test.ts': 3,
      'src/gone.test.ts': 2,
    })
    expect(result.ok).toBe(true)
    expect(result.ledger).toEqual({ 'src/a.test.ts': 1 })
  })

  it('refuses to record a file that was not already owed', () => {
    expect(ratchetLedger(new Map([['src/new.test.ts', 1]]), {}).ok).toBe(false)
  })

  it('refuses to record a count that grew', () => {
    expect(ratchetLedger(new Map([['src/a.test.ts', 4]]), { 'src/a.test.ts': 3 }).ok).toBe(false)
  })
})
