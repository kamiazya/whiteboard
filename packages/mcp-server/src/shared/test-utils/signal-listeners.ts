/**
 * Removes the process signal listeners a test body added, leaving any that were already installed.
 *
 * `runDaemonRun` arms `process.once('SIGTERM' | 'SIGINT')` and the daemon exits before they ever fire
 * in production; a test file that calls it per case never exits, so listeners pile up past Node's
 * limit of 10 per event and emit a `MaxListenersExceededWarning` per signal.
 */
const SIGNALS = ['SIGTERM', 'SIGINT'] as const

export function captureSignalListeners(): { restore: () => void } {
  const before = SIGNALS.map((signal) => new Set(process.listeners(signal)))
  return {
    restore() {
      SIGNALS.forEach((signal, index) => {
        for (const listener of process.listeners(signal)) {
          if (!before[index]?.has(listener)) process.removeListener(signal, listener)
        }
      })
    },
  }
}
