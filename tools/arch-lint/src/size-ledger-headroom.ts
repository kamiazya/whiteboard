/**
 * How far a size ledger's ceiling may stand above the reading it holds.
 *
 * An entry in `file-size-budget.test.ts` or `function-size-budget.test.ts`
 * is a CEILING rather than a reading, so that shrinking what it names is
 * not an edit to the ledger. But the growth guard is only as tight as the
 * ceiling: a 763-line ceiling over a 179-line `App` lets 584 lines be added
 * before anything fires — three times the function, under a guard that
 * reads as holding it. Measured when this landed: 101 of the 349 source
 * function entries stood above their reading, 4836 lines between them, and
 * the test-file ledger carried 625 lines of headroom on one entry.
 *
 * A tenth of the ceiling, or 25 lines, whichever is more. Enough that an
 * ordinary edit under a listed function does not touch the ledger; not
 * enough for one to grow back to what it was recorded at without a reader
 * seeing the number move.
 */
function headroomAllowance(ceiling: number): number {
  return Math.max(25, Math.ceil(ceiling / 10))
}

/**
 * The entries whose ceiling stands further above their reading than the
 * allowance, each as the line the failing assertion prints. A subject the
 * reader cannot measure (deleted, moved) is another assertion's finding and
 * is skipped here.
 */
export function staleHeadroom(
  ledger: Readonly<Record<string, number>>,
  readingOf: (key: string) => number | undefined,
): string[] {
  return Object.entries(ledger).flatMap(([key, ceiling]) => {
    const reading = readingOf(key)
    if (reading === undefined || ceiling - reading <= headroomAllowance(ceiling)) return []
    return [
      `${key}: recorded at ${String(ceiling)}, now ${String(reading)} — lower the ceiling to the reading (headroom allowance is ${String(headroomAllowance(ceiling))})`,
    ]
  })
}
