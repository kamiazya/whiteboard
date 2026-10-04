import { describe, expect, it } from 'vitest'
import {
  compareToLedger,
  interruptedRun,
  parseDiagnostics,
  ratchetLedger,
} from './typecheck-tests-lib.mjs'

const OUTPUT = [
  "src/a.test.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.",
  "  Type 'string' is not assignable to type 'number'.",
  "src/a.test.ts(9,1): error TS2345: Argument of type 'x' is not assignable.",
  'src\\b.test.ts(1,1): error TS2304: Cannot find name y.',
  "error TS5083: Cannot read file 'tsconfig.nope.json'.",
].join('\n')

describe('parseDiagnostics', () => {
  it('records the error codes per file and ignores the continuation lines under them', () => {
    const { byFile } = parseDiagnostics(OUTPUT)
    expect(Object.fromEntries(byFile)).toEqual({
      'src/a.test.ts': ['TS2322', 'TS2345'],
      'src/b.test.ts': ['TS2304'],
    })
  })

  it('returns an error that names no file apart, since a ledger cannot excuse a program that never ran', () => {
    expect(parseDiagnostics(OUTPUT).unattributed).toEqual([
      "error TS5083: Cannot read file 'tsconfig.nope.json'.",
    ])
  })

  it('sorts a file’s codes, so moving an error to another line is not a change', () => {
    const moved = [
      'src/a.test.ts(1,1): error TS2345: x',
      'src/a.test.ts(2,1): error TS2322: y',
    ].join('\n')
    expect(parseDiagnostics(moved).byFile.get('src/a.test.ts')).toEqual(['TS2322', 'TS2345'])
  })
})

describe('compareToLedger', () => {
  const actual = new Map([
    ['src/a.test.ts', ['TS2322', 'TS2345']],
    ['src/b.test.ts', ['TS2304']],
  ])

  it('passes when the actual codes are exactly the ledger', () => {
    expect(
      compareToLedger(actual, {
        'src/a.test.ts': ['TS2322', 'TS2345'],
        'src/b.test.ts': ['TS2304'],
      }).failed,
    ).toBe(false)
  })

  it('fails on an error in a file the ledger does not name', () => {
    const verdict = compareToLedger(actual, { 'src/a.test.ts': ['TS2322', 'TS2345'] })
    expect(verdict.failed).toBe(true)
    expect(verdict.added).toEqual([{ file: 'src/b.test.ts', count: 1, codes: ['TS2304'] }])
  })

  it('fails when a ledgered file gained an error, naming the code', () => {
    const verdict = compareToLedger(actual, {
      'src/a.test.ts': ['TS2322'],
      'src/b.test.ts': ['TS2304'],
    })
    expect(verdict.failed).toBe(true)
    expect(verdict.grew).toEqual([
      {
        file: 'src/a.test.ts',
        count: 2,
        recorded: 1,
        novel: [{ code: 'TS2345', count: 1, recorded: 0 }],
      },
    ])
  })

  it('fails when one recorded error was swapped for a different one, though the count is unchanged', () => {
    const verdict = compareToLedger(actual, {
      'src/a.test.ts': ['TS2322', 'TS2339'],
      'src/b.test.ts': ['TS2304'],
    })
    expect(verdict.failed).toBe(true)
    expect(verdict.swapped).toEqual([
      {
        file: 'src/a.test.ts',
        count: 2,
        recorded: 2,
        novel: [{ code: 'TS2345', count: 1, recorded: 0 }],
      },
    ])
    expect(verdict.grew).toEqual([])
  })

  it('fails when an error was repaired and a second of the same code appeared in its place', () => {
    const verdict = compareToLedger(new Map([['src/a.test.ts', ['TS2322', 'TS2322']]]), {
      'src/a.test.ts': ['TS2322', 'TS2345'],
    })
    expect(verdict.swapped).toHaveLength(1)
  })

  it('fails when a ledgered file carries fewer errors than recorded, so the record follows the repair', () => {
    const verdict = compareToLedger(actual, {
      'src/a.test.ts': ['TS2322', 'TS2345', 'TS2345', 'TS2353', 'TS2554'],
      'src/b.test.ts': ['TS2304'],
    })
    expect(verdict.failed).toBe(true)
    expect(verdict.shrunk).toEqual([{ file: 'src/a.test.ts', count: 2, recorded: 5, novel: [] }])
  })

  it('fails when a ledgered file has no errors left at all', () => {
    const verdict = compareToLedger(actual, {
      'src/a.test.ts': ['TS2322', 'TS2345'],
      'src/b.test.ts': ['TS2304'],
      'src/c.test.ts': ['TS2322', 'TS2322', 'TS2322', 'TS2322'],
    })
    expect(verdict.failed).toBe(true)
    expect(verdict.cleared).toEqual([{ file: 'src/c.test.ts', recorded: 4 }])
  })
})

describe('ratchetLedger', () => {
  it('records paid-down debt', () => {
    const result = ratchetLedger(new Map([['src/a.test.ts', ['TS2322']]]), {
      'src/a.test.ts': ['TS2322', 'TS2345', 'TS2353'],
      'src/gone.test.ts': ['TS2304', 'TS2304'],
    })
    expect(result.ok).toBe(true)
    expect(result.ledger).toEqual({ 'src/a.test.ts': ['TS2322'] })
  })

  it('refuses to record a file that was not already owed', () => {
    expect(ratchetLedger(new Map([['src/new.test.ts', ['TS2322']]]), {}).ok).toBe(false)
  })

  it('refuses to record a count that grew', () => {
    expect(
      ratchetLedger(new Map([['src/a.test.ts', ['TS2322', 'TS2322', 'TS2322', 'TS2322']]]), {
        'src/a.test.ts': ['TS2322', 'TS2322', 'TS2322'],
      }).ok,
    ).toBe(false)
  })

  it('refuses to record a swapped error as paid-down debt', () => {
    expect(
      ratchetLedger(new Map([['src/a.test.ts', ['TS2339']]]), { 'src/a.test.ts': ['TS2322'] }).ok,
    ).toBe(false)
  })
})

describe('interruptedRun', () => {
  it('refuses a compiler killed by a signal, whose partial output would read as cleared debt', () => {
    expect(interruptedRun({ status: null, signal: 'SIGKILL' })).toMatch(/SIGKILL/)
  })

  it('refuses a compiler that exited with a status tsc never uses for type errors', () => {
    expect(interruptedRun({ status: 137, signal: null })).toMatch(/137/)
  })

  it('accepts a clean run and a run that reported type errors', () => {
    expect(interruptedRun({ status: 0, signal: null })).toBeUndefined()
    expect(interruptedRun({ status: 1, signal: null })).toBeUndefined()
    expect(interruptedRun({ status: 2, signal: null })).toBeUndefined()
  })
})
