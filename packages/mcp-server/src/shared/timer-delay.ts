/**
 * The longest delay `setTimeout` honours: a signed 32-bit integer of
 * milliseconds. Anything larger is silently truncated to 1ms, which turns a
 * schedule more than 24.8 days out (a monthly cron, a long file-GC interval)
 * into a near-continuous loop. A caller clamps to this and re-arms when it
 * wakes and finds its target still ahead.
 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647
