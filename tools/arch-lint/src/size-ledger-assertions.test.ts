import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { registerSizeLedgerAssertions, SizeEntry } from './size-ledger-assertions.js'

// `registerSizeLedgerAssertions` registers `it`s in whatever suite calls it, so
// its judgement can only be observed by running what it registered. The module
// is loaded afresh against a `vitest` whose `it` records instead of
// registering, and the mock and the module registry are dropped afterwards:
// this project runs with `isolate: false`, so a mock left standing would be
// the next file's.
const registered = new Map<string, () => void>()
let register: typeof registerSizeLedgerAssertions

beforeAll(async () => {
  vi.resetModules()
  vi.doMock('vitest', async (importOriginal) => ({
    ...(await importOriginal<typeof import('vitest')>()),
    it: (title: string, body: () => void) => registered.set(title, body),
  }))
  ;({ registerSizeLedgerAssertions: register } = await import('./size-ledger-assertions.js'))
})

afterAll(() => {
  vi.doUnmock('vitest')
  vi.resetModules()
})

const TITLES = {
  unlisted: 'unlisted',
  grown: 'grown',
  shrunk: 'shrunk',
  missing: 'missing',
  headroom: 'headroom',
} as const

/** What each registered assertion says about one ledger, keyed by its title. */
function judge(subject: {
  budget: number
  entries: readonly SizeEntry[]
  ledger: Record<string, number>
  readings: Record<string, number | undefined>
}): Record<keyof typeof TITLES, 'passes' | 'fails'> {
  registered.clear()
  register({
    budget: subject.budget,
    entries: subject.entries,
    ledgers: [subject.ledger],
    ledgerOf: () => subject.ledger,
    readingOf: (key) => subject.readings[key],
    wording: {
      titles: TITLES,
      unlisted: (entry) => `${entry.key} unlisted`,
      grown: (key) => `${key} grown`,
      shrunk: (key) => `${key} shrunk`,
    },
  })
  const outcome = (title: string): 'passes' | 'fails' => {
    try {
      registered.get(title)?.()
      return 'passes'
    } catch {
      return 'fails'
    }
  }
  return {
    unlisted: outcome(TITLES.unlisted),
    grown: outcome(TITLES.grown),
    shrunk: outcome(TITLES.shrunk),
    missing: outcome(TITLES.missing),
    headroom: outcome(TITLES.headroom),
  }
}

describe('registerSizeLedgerAssertions — the boundaries of each judgement', () => {
  it('registers all five assertions, so a judgement missing from the call cannot pass unnoticed', () => {
    judge({ budget: 100, entries: [], ledger: {}, readings: {} })
    expect([...registered.keys()].sort()).toEqual(Object.values(TITLES).sort())
  })

  it('lets a subject sit exactly at its ceiling and fails one a line past it', () => {
    const at = judge({
      budget: 100,
      entries: [{ key: 'a', lines: 150 }],
      ledger: { a: 150 },
      readings: { a: 150 },
    })
    expect(at.grown).toBe('passes')
    const past = judge({
      budget: 100,
      entries: [{ key: 'a', lines: 151 }],
      ledger: { a: 150 },
      readings: { a: 151 },
    })
    expect(past.grown).toBe('fails')
  })

  it('asks a listed subject sitting exactly at the budget to leave the ledger, and not one a line over', () => {
    const at = judge({
      budget: 100,
      entries: [{ key: 'a', lines: 100 }],
      ledger: { a: 100 },
      readings: { a: 100 },
    })
    expect(at.shrunk).toBe('fails')
    const over = judge({
      budget: 100,
      entries: [{ key: 'a', lines: 101 }],
      ledger: { a: 101 },
      readings: { a: 101 },
    })
    expect(over.shrunk).toBe('passes')
  })

  it('does not fail a subject exactly at the budget, nor an over-budget one that is listed', () => {
    expect(
      judge({ budget: 100, entries: [{ key: 'a', lines: 100 }], ledger: {}, readings: {} })
        .unlisted,
    ).toBe('passes')
    expect(
      judge({
        budget: 100,
        entries: [{ key: 'a', lines: 120 }],
        ledger: { a: 120 },
        readings: { a: 120 },
      }).unlisted,
    ).toBe('passes')
  })

  it('fails an over-budget subject nobody listed, and one whose subject has gone', () => {
    expect(
      judge({ budget: 100, entries: [{ key: 'a', lines: 101 }], ledger: {}, readings: {} })
        .unlisted,
    ).toBe('fails')
    expect(judge({ budget: 100, entries: [], ledger: { gone: 200 }, readings: {} }).missing).toBe(
      'fails',
    )
  })
})
