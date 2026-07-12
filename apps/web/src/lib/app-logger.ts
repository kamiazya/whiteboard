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
    // stores the stub under the key 'import.meta' (literal dot) on globalThis, so we
    // look that up first to let tests override it after the module is imported.
    // When no stub is present (the real running app), this falls through to the
    // genuine `import.meta` object that Vite injects at runtime — `import.meta.env.DEV`
    // is a real, always-populated property there, not just a build-time literal
    // substitution, so the fallback reflects the actual dev/prod build correctly.
    const g = globalThis as Record<string, unknown>
    const importMeta = (g['import.meta'] ?? import.meta) as
      | { env?: Record<string, unknown> }
      | undefined
    const isDev = importMeta?.['env']?.['DEV'] === true
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
