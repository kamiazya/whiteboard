import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'
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

/**
 * A socket path in an owner-only directory this file creates and removes
 * after its tests: a record whose socket directory is missing is never
 * `running`, so a fixture naming a path on no disk would read as held.
 * Called at a test file's top level.
 */
export function ownedSocketPath(name = 'd.sock'): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-rec-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  return join(dir, name)
}
