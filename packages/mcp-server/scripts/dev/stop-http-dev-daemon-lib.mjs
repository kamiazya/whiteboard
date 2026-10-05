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
import { assessRecordedDaemon, recordedProcess } from './dev-daemon-socket-lib.mjs'

/**
 * Whether the record's process is running is `assessRecordedDaemon`'s answer,
 * the one the wrapper and the SessionStart hook use too; only a pid it takes
 * for the daemon is ever signalled. A record whose pid now belongs to some
 * other process is reported as stale instead, since signalling it would stop
 * a stranger.
 *
 * @param {{
 *   dataDir: string,
 *   readRecord: (dataDir: string) => { pid: number, socketPath: string, startedAt?: string } | null,
 *   readWrapperPid: (dataDir: string) => number | null,
 *   isAlive: (pid: number) => boolean,
 *   kill: (pid: number, signal: string) => unknown,
 *   sleep: (ms: number) => Promise<unknown>,
 *   answers?: (record: { socketPath: string }) => Promise<boolean>,
 *   startMs?: (pid: number) => number | null,
 *   timeoutMs?: number,
 *   pollMs?: number,
 * }} input
 * @returns {Promise<
 *   | { kind: 'none' }
 *   | { kind: 'stale', pid: number, reason: string }
 *   | { kind: 'unsignallable', pid: number, reason: string }
 *   | { kind: 'stopped', via: 'wrapper' | 'daemon', pid: number }
 *   | { kind: 'timeout', pid: number }
 * >}
 */
export async function stopDevDaemon({
  dataDir,
  readRecord,
  readWrapperPid,
  isAlive,
  kill,
  sleep,
  answers,
  startMs,
  timeoutMs = 10_000,
  pollMs = 100,
}) {
  const record = readRecord(dataDir)
  if (record === null) return { kind: 'none' }
  const daemon = await assessRecordedDaemon(record, { answers, isAlive, startMs })
  if (daemon.process === 'foreign') {
    return {
      kind: 'stale',
      pid: record.pid,
      reason: `pid ${record.pid} is alive but started after the record was written (${record.startedAt}), so it is not the daemon the record describes`,
    }
  }
  if (daemon.process === 'dead') {
    return daemon.answering
      ? {
          kind: 'unsignallable',
          pid: record.pid,
          reason: `a daemon answers on ${record.socketPath}, but the pid its record names (${record.pid}) is not running`,
        }
      : { kind: 'none' }
  }

  // A pid file left by a SIGKILLed wrapper can name a pid since reused; a
  // process that started after the daemon wrote its record cannot be the
  // wrapper that launched it.
  const wrapperPid = readWrapperPid(dataDir)
  const via =
    wrapperPid !== null &&
    recordedProcess(wrapperPid, record.startedAt, { isAlive, startMs }) === 'daemon'
      ? 'wrapper'
      : 'daemon'
  const target = via === 'wrapper' ? /** @type {number} */ (wrapperPid) : record.pid
  kill(target, 'SIGTERM')

  const gone = await settles(() => !isAlive(record.pid) && !isAlive(target), {
    sleep,
    timeoutMs,
    pollMs,
  })
  return gone ? { kind: 'stopped', via, pid: target } : { kind: 'timeout', pid: target }
}

/**
 * Whether `done` holds within `timeoutMs`, asked every `pollMs` through the
 * injected sleep; the first look is immediate.
 * @param {() => boolean} done
 * @param {{ sleep: (ms: number) => Promise<unknown>, timeoutMs: number, pollMs: number }} clock
 * @returns {Promise<boolean>}
 */
async function settles(done, clock) {
  if (done()) return true
  if (clock.timeoutMs < clock.pollMs) return false
  await clock.sleep(clock.pollMs)
  return settles(done, { ...clock, timeoutMs: clock.timeoutMs - clock.pollMs })
}
