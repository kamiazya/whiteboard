// How long a stopping process may take, defined once so the cap a close waits
// out and the window a CLI waits for it cannot drift apart.
//
// Lives in `shared/` rather than beside the sweeper because the CLI's stop
// commands import it, and `server/shared-background-work.ts` reaches the
// stores: a read-only command must not load those to learn a number.

/**
 * Caps how long close() waits for an in-flight file-gc pass before the rest
 * of shutdown proceeds. A full pass can be expensive, and a shutdown that
 * appears to hang is worse than one that leaves a pass to finish in the
 * background.
 */
export const FILE_GC_STOP_TIMEOUT_MS = 5_000

/** What the rest of a close (listener drain, final flush) may take beyond the sweeper's cap. */
const CLOSE_MARGIN_MS = 5_000

/**
 * How long a stop command gives SIGTERM before it forces the process. The
 * sweeper's cap alone would SIGKILL a daemon that is still stopping cleanly,
 * so the window is that cap plus the margin the rest of the close needs.
 */
export const STOP_SIGTERM_WINDOW_MS = FILE_GC_STOP_TIMEOUT_MS + CLOSE_MARGIN_MS
