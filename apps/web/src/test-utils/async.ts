/** One macrotask turn: lets whatever the last action scheduled run before the next assertion. */
export const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * A promise a test settles by hand, so an overlap or ordering scenario is
 * decided by the test rather than by real timing.
 *
 * `Promise.withResolvers` is this exact shape, but it is ES2024 and apps/web's
 * `lib` is ES2022, so it does not typecheck here.
 */
export function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
