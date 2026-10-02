/**
 * Lets promise continuations chained a few deep run to completion without a
 * timer, so a test asserts what settled rather than how long it took. A
 * chain deeper than `turns` needs more turns, or a condition to wait on.
 */
export async function flush(turns = 30): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve()
}
