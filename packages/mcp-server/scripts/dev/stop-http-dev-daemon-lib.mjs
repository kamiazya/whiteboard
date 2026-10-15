// The decision half of `pnpm mcp:http:stop`: stop THIS checkout's dev daemon
// without matching process names, which cannot tell one checkout's
// `pnpm mcp:http:dev` from another's.
//
// The checkout is identified by its data dir, which names exactly one daemon
// (`daemon.json`) and one wrapper (`dev-wrapper.pid`, written by
// with-dev-data-dir.mjs). The wrapper of a source daemon is signalled when it
// is there, because it forwards the signal down to `tsx watch` and the daemon;
// signalling only the daemon would leave the watcher to restart it on the next
// file change. A wrapper whose daemon is down is stopped on its own, since it
// would restart one on the next edit. All process access is injected so the
// decision is testable without one.
import {
  assessRecordedDaemon,
  BUILT_LAUNCH,
  isPidFileWriter,
  isRecordWriter,
} from './dev-daemon-socket-lib.mjs'

/**
 * Whether the record's process is running is `assessRecordedDaemon`'s answer,
 * the one the wrapper and the SessionStart hook use too; only a pid it takes
 * for the daemon is ever signalled. A record whose pid now belongs to some
 * other process is reported as stale instead, since signalling it would stop
 * a stranger.
 *
 * @param {{
 *   dataDir: string,
 *   readRecord: (dataDir: string) => { pid: number, socketPath: string, startedAt?: string, launch?: string } | null,
 *   readWrapper: (dataDir: string) => { pid: number, writtenAtMs: number } | null,
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
 *   | { kind: 'timeout', pid: number, signalled: number }
 * >}
 */
export async function stopDevDaemon({
  dataDir,
  readRecord,
  readWrapper,
  isAlive,
  kill,
  sleep,
  answers,
  startMs,
  timeoutMs = 10_000,
  pollMs = 100,
}) {
  const clock = { sleep, timeoutMs, pollMs }
  const wrapper = readWrapper(dataDir)
  const record = readRecord(dataDir)
  if (record === null) return stopOrphanWrapper(wrapper, { isAlive, startMs, kill, clock })
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
      : stopOrphanWrapper(wrapper, { isAlive, startMs, kill, clock })
  }

  // No wrapper launches a build, so a built daemon is its own target. A pid
  // file left by a SIGKILLed wrapper can name a pid since reused; a process
  // that started after the daemon wrote its record cannot be the wrapper that
  // launched it.
  const via =
    record.launch !== BUILT_LAUNCH &&
    wrapper !== null &&
    isRecordWriter(wrapper.pid, record.startedAt, { isAlive, startMs })
      ? 'wrapper'
      : 'daemon'
  const target = via === 'wrapper' ? /** @type {{ pid: number }} */ (wrapper).pid : record.pid
  kill(target, 'SIGTERM')

  const gone = await settles(() => !isAlive(record.pid) && !isAlive(target), clock)
  if (gone) return { kind: 'stopped', via, pid: target }
  return { kind: 'timeout', pid: isAlive(target) ? target : record.pid, signalled: target }
}

/**
 * With no daemon up, the wrapper the pid file names — if it is still the
 * process that wrote that file — is stopped; otherwise there is nothing to stop.
 *
 * @param {{ pid: number, writtenAtMs: number } | null} wrapper
 * @param {{ isAlive: (pid: number) => boolean, startMs?: (pid: number) => number | null, kill: (pid: number, signal: string) => unknown, clock: { sleep: (ms: number) => Promise<unknown>, timeoutMs: number, pollMs: number } }} seams
 */
async function stopOrphanWrapper(wrapper, { isAlive, startMs, kill, clock }) {
  if (
    wrapper === null ||
    !isPidFileWriter(wrapper.pid, wrapper.writtenAtMs, { isAlive, startMs })
  ) {
    return { kind: 'none' }
  }
  kill(wrapper.pid, 'SIGTERM')
  const gone = await settles(() => !isAlive(wrapper.pid), clock)
  return gone
    ? { kind: 'stopped', via: 'wrapper', pid: wrapper.pid }
    : { kind: 'timeout', pid: wrapper.pid, signalled: wrapper.pid }
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
