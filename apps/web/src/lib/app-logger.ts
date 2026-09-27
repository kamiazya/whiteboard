export interface AppLogger {
  error(message: string, ...context: unknown[]): void
  warn(message: string, ...context: unknown[]): void
  info(message: string, ...context: unknown[]): void
  debug(message: string, ...context: unknown[]): void
}

/**
 * Browser-safe logger for the app/ layer.
 * In dev mode, forwards structured records to the browser console.
 * In prod mode, all methods are no-ops so no console noise ships to users.
 *
 * The DEV check is evaluated at call time (not module load time) so that
 * vi.stubGlobal('import.meta', ...) in tests can switch branches after
 * the module is imported.
 */
export function getAppLogger(name: string): AppLogger {
  const tag = `[${name}]`

  function log(
    level: 'error' | 'warn' | 'info' | 'debug',
    message: string,
    context: unknown[],
  ): void {
    // Read DEV at call time (not module load time). vi.stubGlobal('import.meta', ...)
    // stores the stub under the key 'import.meta' (literal dot) on globalThis, so a
    // test's stub is looked up first. Otherwise `import.meta.env` is read AS
    // WRITTEN: Vite injects `env` only where the source spells that member
    // expression. Off a bare `import.meta` held in a variable a browser build
    // finds no `env`, and every record is dropped without a sign.
    const g = globalThis as Record<string, unknown>
    const stubbed = g['import.meta'] as { env?: Record<string, unknown> } | undefined
    const env = stubbed?.env ?? import.meta.env
    const isDev = env?.DEV === true
    if (isDev) {
      // biome-ignore lint/suspicious/noConsole: this is the one intended sink apps/web routes diagnostics through
      console[level](`${tag} ${message}`, ...context)
    }
  }

  return {
    error(message: string, ...context: unknown[]): void {
      log('error', message, context)
    },
    warn(message: string, ...context: unknown[]): void {
      log('warn', message, context)
    },
    info(message: string, ...context: unknown[]): void {
      log('info', message, context)
    },
    debug(message: string, ...context: unknown[]): void {
      log('debug', message, context)
    },
  }
}

/**
 * Reports an unrecoverable failure through a channel that survives the
 * production build — the deliberate exception to every level on
 * `AppLogger`, which is dev-only diagnostic noise by design (it no-ops in
 * prod so routine failures like a debounced scene-sync retry never reach a
 * user's console).
 *
 * `reportCrash` exists for `ErrorBoundary.componentDidCatch` only: once
 * React has torn down the tree and shown the fallback UI, a silent prod
 * build leaves the user with nothing to paste into a bug report. If a
 * second call site wants this channel, treat that as a deliberate review
 * conversation, not a default to reach for.
 */
export function reportCrash(name: string, message: string, context: Record<string, unknown>): void {
  // biome-ignore lint/suspicious/noConsole: intentional production-visible sink for unrecoverable crash reports — see the doc comment above
  console.error(`[${name}] ${message}`, context)
}
