import { describe, expect, it } from 'vitest'
import {
  assertLedger,
  assertScannedLedger,
  danglingTestCitations,
  KNOWN_TEST_BASENAMES,
  type SurfaceCoverage,
} from './coverage-ledger'

const KNOWN = new Set(['commands.test.ts', 'comment-reply.browser.test.tsx'])

describe('the set of test files a ledger reason may cite', () => {
  it('holds this repo’s tests, including those outside apps/web', () => {
    // A glob that matched nothing would make every citation dangle, and one
    // that matched only this app would do it for the cross-package ones, so
    // both ends are asserted: this file, and a mcp-server test that
    // `scoped-screen-state.test.ts` really cites.
    expect(KNOWN_TEST_BASENAMES.size).toBeGreaterThan(1000)
    expect(KNOWN_TEST_BASENAMES.has('coverage-ledger.test.ts')).toBe(true)
    expect(KNOWN_TEST_BASENAMES.has('web-app-boundary.test.ts')).toBe(true)
  })
})

describe('danglingTestCitations', () => {
  it('names a cited test file that exists nowhere, with the entry that cites it', () => {
    expect(
      danglingTestCitations(
        { gone: 'not modelled: the gesture is covered by proposal-adopt.browser.test.tsx' },
        KNOWN,
      ),
    ).toEqual([{ entry: 'gone', cited: 'proposal-adopt.browser.test.tsx' }])
  })

  it('accepts a citation that resolves, with trailing punctuation and a directory prefix', () => {
    expect(
      danglingTestCitations(
        {
          a: 'not modelled: see commands.test.ts, and also (comment-reply.browser.test.tsx).',
          b: 'not modelled: owned by src/lib/commands.test.ts',
        },
        KNOWN,
      ),
    ).toEqual([])
  })

  it('reads every citation in a reason, not just the first', () => {
    expect(
      danglingTestCitations(
        { a: 'not modelled: commands.test.ts then nope.test.ts then also-nope.test.tsx' },
        KNOWN,
      ),
    ).toEqual([
      { entry: 'a', cited: 'nope.test.ts' },
      { entry: 'a', cited: 'also-nope.test.tsx' },
    ])
  })

  it('leaves a suffix pattern, a covered entry and a non-string value alone', () => {
    expect(
      danglingTestCitations(
        {
          a: 'not modelled: a .browser.test.tsx would be the home for it',
          b: 'covered',
          c: { cites: 'nope.test.ts' },
        },
        KNOWN,
      ),
    ).toEqual([])
  })
})

describe('the ledger helpers refuse a reason citing a test that is not there', () => {
  const dangling = { member: 'not modelled: covered by proposal-adopt.browser.test.tsx' } as const

  it('assertLedger, naming the entry and the file', () => {
    const ledger: Record<'member', SurfaceCoverage> = dangling
    expect(() => assertLedger('member', ledger, { member: 0 })).toThrow(
      /"member".*proposal-adopt\.browser\.test\.tsx/s,
    )
  })

  it('assertScannedLedger, naming the entry and the file', () => {
    expect(() =>
      assertScannedLedger(['member'], dangling, { unclassified: 'unclassified', stale: 'stale' }),
    ).toThrow(/"member".*proposal-adopt\.browser\.test\.tsx/s)
  })

  it('both stay quiet for a citation that resolves', () => {
    const ledger: Record<'member', SurfaceCoverage> = {
      member: 'not modelled: covered by coverage-ledger.test.ts',
    }
    expect(() => assertLedger('member', ledger, { member: 0 })).not.toThrow()
    expect(() =>
      assertScannedLedger(['member'], ledger, { unclassified: 'unclassified', stale: 'stale' }),
    ).not.toThrow()
  })
})

describe('assertLedger holds the two runtime directions', () => {
  it('direction 3: a covered entry the run never produced fails', () => {
    const ledger: Record<'a', SurfaceCoverage> = { a: 'covered' }
    expect(() => assertLedger('member', ledger, { a: 0 })).toThrow(/never produced/)
  })

  it('direction 3 control: a covered entry the run produced passes', () => {
    const ledger: Record<'a', SurfaceCoverage> = { a: 'covered' }
    expect(() => assertLedger('member', ledger, { a: 2 })).not.toThrow()
  })

  it('direction 4: a not-modelled entry the run did produce fails as stale', () => {
    const ledger: Record<'a', SurfaceCoverage> = { a: 'not modelled: a reason' }
    expect(() => assertLedger('member', ledger, { a: 3 })).toThrow(/stale/)
  })
})

describe('assertScannedLedger holds both scan directions', () => {
  const messages = { unclassified: 'UNCLASSIFIED', stale: 'STALE' }

  it('an unclassified scanned name fails with the call site’s message', () => {
    expect(() => assertScannedLedger(['x', 'y'], { x: 'covered' }, messages)).toThrow(
      /UNCLASSIFIED/,
    )
  })

  it('a stale entry the scan no longer finds fails with the call site’s message', () => {
    expect(() => assertScannedLedger(['x'], { x: 'covered', gone: 'covered' }, messages)).toThrow(
      /STALE/,
    )
  })
})
