/** Edits within this window (ms) of each other coalesce into one commit. */
export const COMMIT_DEBOUNCE_MS = 300

/**
 * The longest an edit waits for that quiet period. Typing or dragging that
 * never pauses for `COMMIT_DEBOUNCE_MS` would otherwise write nothing until
 * it stops: minutes of work held only in memory, and an unsaved span the shell
 * rightly reads as stuck (`STUCK_AFTER_MS`). Well under that threshold, so a
 * sustained burst is written, and reads as saved, long before it could trip.
 */
export const COMMIT_MAX_WAIT_MS = 2_000

/**
 * The quiet-period timer behind a session's commits: `arm` on every edit,
 * `cancel` when the edits are taken some other way (a flush, a dropped write).
 * `fire` runs once the edits have been quiet for the debounce, or the first of
 * them has waited the max wait.
 */
export function createCommitDebounce(fire: () => void) {
  let timer: ReturnType<typeof setTimeout> | null = null
  let startedAt: number | null = null
  const cancel = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
    startedAt = null
  }
  return {
    arm(): void {
      const now = Date.now()
      startedAt ??= now
      if (timer) clearTimeout(timer)
      const untilMaxWait = startedAt + COMMIT_MAX_WAIT_MS - now
      timer = setTimeout(
        () => {
          cancel()
          fire()
        },
        Math.max(0, Math.min(COMMIT_DEBOUNCE_MS, untilMaxWait)),
      )
    },
    cancel,
    isArmed: (): boolean => timer !== null,
  }
}
