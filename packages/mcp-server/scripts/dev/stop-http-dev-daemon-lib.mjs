// The decision half of `pnpm mcp:http:stop`: stop THIS checkout's dev daemon
// without matching process names, which cannot tell one checkout's
// `pnpm mcp:http:dev` from another's.
//
// The checkout is identified by its data dir, which names exactly one daemon
// (`daemon.json`) and one wrapper (`dev-wrapper.pid`, written by
// with-dev-data-dir.mjs). The wrapper is signalled when it is there, because
// it forwards the signal down to `tsx watch` and the daemon; signalling only
// the daemon would leave the watcher to restart it on the next file change.
// All process access is injected so the decision is testable without one.

/**
 * @param {{
 *   dataDir: string,
 *   readRecord: (dataDir: string) => { pid: number } | null,
 *   readWrapperPid: (dataDir: string) => number | null,
 *   isAlive: (pid: number) => boolean,
 *   kill: (pid: number, signal: string) => unknown,
 *   sleep: (ms: number) => Promise<unknown>,
 *   timeoutMs?: number,
 *   pollMs?: number,
 * }} input
 * @returns {Promise<{ kind: 'none' } | { kind: 'stopped', via: 'wrapper' | 'daemon', pid: number } | { kind: 'timeout', pid: number }>}
 */
export async function stopDevDaemon({
  dataDir,
  readRecord,
  readWrapperPid,
  isAlive,
  kill,
  sleep,
  timeoutMs = 10_000,
  pollMs = 100,
}) {
  const record = readRecord(dataDir)
  if (record === null || !isAlive(record.pid)) return { kind: 'none' }

  // ponytail: a pid file left by a SIGKILLed wrapper can name a pid since
  // reused; it is only trusted while the daemon it supervised is alive too.
  // A process-start-time check is the upgrade if that ever bites.
  const wrapperPid = readWrapperPid(dataDir)
  const via = wrapperPid !== null && isAlive(wrapperPid) ? 'wrapper' : 'daemon'
  const target = via === 'wrapper' ? /** @type {number} */ (wrapperPid) : record.pid
  kill(target, 'SIGTERM')

  for (let waited = 0; waited <= timeoutMs; waited += pollMs) {
    if (!isAlive(record.pid) && !isAlive(target)) return { kind: 'stopped', via, pid: target }
    await sleep(pollMs)
  }
  return { kind: 'timeout', pid: target }
}
