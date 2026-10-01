import { expect, it } from 'vitest'
import { staleHeadroom } from './size-ledger-headroom.js'

/** A shrink-only grandfather list: key to the ceiling its subject must stay at or under. */
type SizeLedger = Readonly<Record<string, number>>

/** One measured subject — a file, or a function — and its size. */
export interface SizeEntry {
  readonly key: string
  readonly lines: number
}

/**
 * The words a call site says its failures in. Titles and messages stay with
 * the guard that owns them: what is shared is the JUDGEMENT (over budget and
 * unlisted, past its ceiling, shrunk to budget, gone, ceiling far above its
 * reading), not the sentence telling a reader what to do about it — a file
 * and a function are closed differently.
 */
interface SizeLedgerWording<E extends SizeEntry> {
  readonly titles: {
    readonly unlisted: string
    readonly grown: string
    readonly shrunk: string
    readonly missing: string
    readonly headroom: string
  }
  readonly unlisted: (entry: E) => string
  readonly grown: (key: string, reading: number, ceiling: number) => string
  readonly shrunk: (key: string, reading: number) => string
}

export interface SizeLedgerSubject<E extends SizeEntry> {
  readonly budget: number
  /** Everything measured, so an over-budget subject nobody listed is found. */
  readonly entries: readonly E[]
  /** Every ledger whose keys are checked against `readingOf`. */
  readonly ledgers: readonly SizeLedger[]
  /** The one ledger an entry must be recorded in. */
  readonly ledgerOf: (entry: E) => SizeLedger
  /** A listed key's current size, or nothing for one that is gone. */
  readonly readingOf: (key: string) => number | undefined
  readonly wording: SizeLedgerWording<E>
}

/**
 * Registers the five assertions every shrink-only size ledger makes, in the
 * surrounding suite: no unlisted over-budget subject, none past its ceiling,
 * none that shrank to budget, none that vanished, none whose ceiling stands
 * far above its reading.
 *
 * Each is one half of a both-sides guard, so an entry cannot outlive the
 * debt it names. A population-size floor and any cross-ledger check stay at
 * the call site, because what counts as a plausible population is the
 * caller's subject.
 */
export function registerSizeLedgerAssertions<E extends SizeEntry>(
  subject: SizeLedgerSubject<E>,
): void {
  const { budget, entries, ledgers, ledgerOf, readingOf, wording } = subject
  const listed = ledgers.flatMap((ledger) => Object.keys(ledger))

  it(wording.titles.unlisted, () => {
    const unlisted = entries
      .filter((entry) => entry.lines > budget && !(entry.key in ledgerOf(entry)))
      .map(wording.unlisted)
    expect(unlisted).toEqual([])
  })

  it(wording.titles.grown, () => {
    const grown = ledgers.flatMap((ledger) =>
      Object.entries(ledger).flatMap(([key, ceiling]) => {
        const reading = readingOf(key)
        return reading !== undefined && reading > ceiling
          ? [wording.grown(key, reading, ceiling)]
          : []
      }),
    )
    expect(grown).toEqual([])
  })

  it(wording.titles.shrunk, () => {
    const shrunk = listed.flatMap((key) => {
      const reading = readingOf(key)
      return reading !== undefined && reading <= budget ? [wording.shrunk(key, reading)] : []
    })
    expect(shrunk).toEqual([])
  })

  it(wording.titles.missing, () => {
    expect(listed.filter((key) => readingOf(key) === undefined)).toEqual([])
  })

  // The growth assertion is only as tight as the ceiling, and a ceiling that
  // stopped being lowered as its subject shrank is a guard that reads as
  // holding it: see `size-ledger-headroom.ts`.
  it(wording.titles.headroom, () => {
    expect(ledgers.flatMap((ledger) => staleHeadroom(ledger, readingOf))).toEqual([])
  })
}
