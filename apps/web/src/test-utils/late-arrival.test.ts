/**
 * The helper's own two branches, driven by a COUNTER rather than a clock:
 * "arrives on the fifth look" needs no sleep to arrange, and a sleep in a
 * test is what `test-fixed-sleep-ledger` exists to keep out.
 */
import { describe, expect, it } from 'vitest'
import { waitForOrSayWhen } from './late-arrival.js'

describe('a wait that says when', () => {
  it('returns quietly when the subject is already there', async () => {
    let looks = 0
    await waitForOrSayWhen(
      () => {
        looks += 1
      },
      { budgetMs: 1_000, subject: 'the subject' },
    )
    expect(looks).toBeGreaterThan(0)
  })

  it('reports HOW LATE a subject that arrives after the budget was', async () => {
    let looks = 0
    const arrivesOnTheFifthLook = () => {
      looks += 1
      // A distinctive refusal, so the assertion below can require that the
      // LATE branch carries what the first wait saw too — the never-arrived
      // branch carrying it is a different code path.
      if (looks < 5) throw new Error('the preview still said Loading')
    }
    await expect(
      waitForOrSayWhen(arrivesOnTheFifthLook, {
        budgetMs: 1,
        graceMs: 5_000,
        subject: "the embed's content",
      }),
    ).rejects.toThrow(/the embed's content arrived \d+ms AFTER its 1ms budget/)

    // ...and the SAME failure says what the wait was looking at when it gave
    // up, which is how a CI log answers "loading, or loaded and empty?".
    let looksAgain = 0
    await expect(
      waitForOrSayWhen(
        () => {
          looksAgain += 1
          if (looksAgain < 5) throw new Error('the preview still said Loading')
        },
        { budgetMs: 1, graceMs: 5_000, subject: "the embed's content" },
      ),
    ).rejects.toThrow(/the preview still said Loading/)
  })

  it('says the budget is not the answer when the subject never arrives', async () => {
    await expect(
      waitForOrSayWhen(
        () => {
          throw new Error('never')
        },
        { budgetMs: 1, graceMs: 20, subject: 'the subject' },
      ),
    ).rejects.toThrow(/had still not arrived 20ms later — so this is not the budget/)
  })

  it('carries what the first wait last saw, so the reason is not lost', async () => {
    await expect(
      waitForOrSayWhen(
        () => {
          expect('what the page shows').toContain('what the test wants')
        },
        { budgetMs: 1, graceMs: 20, subject: 'the subject' },
      ),
    ).rejects.toThrow(/what the page shows/)
  })
})
