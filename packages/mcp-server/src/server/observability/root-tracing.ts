import { initTracing } from './tracing.js'

/**
 * Which HTTP composition root is starting. It becomes the `whiteboard.role`
 * resource attribute, so the daemon and a server-mode deployment stay
 * separable in one collector.
 */
export type HttpRootRole = 'daemon' | 'server'

/**
 * Starts tracing for an HTTP composition root, once, before the root builds
 * anything that serves a request.
 *
 * This is the root's job and not the process entry's because the entries
 * differ: `whiteboard daemon run` and `whiteboard server run` call
 * `startHttpServer` / `startServerModeHttp` in-process and never reach the dev
 * entry's `main`. Tracing initialised only there left `WHITEBOARD_OTEL` a
 * silent no-op on every shipped deployment, while the spans it would have
 * exported are compiled into `createApp` for all of them.
 *
 * A no-op unless an operator opted in (`tracingEnabled`), and idempotent, so
 * a root started twice in one process (tests) initialises the SDK once.
 */
export async function startHttpRootTracing(role: HttpRootRole): Promise<void> {
  await initTracing({ role })
}
