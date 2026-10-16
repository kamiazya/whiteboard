import { type DaemonLivenessSeams, daemonLiveness } from './daemon-liveness.js'
import type { DaemonRecord, RecordedDaemon } from './daemon-record-schema.js'

/**
 * A `parseRecord` double answering `valid` for `record`, its liveness asked
 * through the seams the command passes — as `parseDaemonRecord` asks it — so a
 * test's process doubles still decide whether the daemon is there.
 */
export function validParse(record: DaemonRecord) {
  return async (_dataDir: string, seams?: DaemonLivenessSeams) =>
    ({ kind: 'valid', record, liveness: await daemonLiveness(record, seams) }) as const
}

/** A `loadDaemonRecord` double answering `record`, its liveness asked the same way. */
export function loadedRecord<R extends RecordedDaemon>(record: R) {
  return async (_dataDir?: string, seams?: unknown) => ({
    record,
    liveness: await daemonLiveness(record, seams as DaemonLivenessSeams | undefined),
  })
}
