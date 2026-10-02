/** One macrotask turn: lets whatever the last action scheduled run before the next assertion. */
export const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
