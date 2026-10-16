import { mkdir, rm } from 'node:fs/promises'
import { DATA_DIR } from '../shared/data-dir-secure.js'
import { writeFileAtomic } from '../shared/write-file-atomic.js'
import type { DaemonLivenessSeams } from './daemon-liveness.js'
import {
  type DaemonRecordParseResult,
  describeOccupant,
  getDaemonRecordPath,
  isOccupying,
  parseDaemonRecord,
} from './daemon-record.js'
import type { DaemonRecordWrite } from './daemon-record-schema.js'

export { DAEMON_RECORD_FILENAME, getDaemonRecordPath } from './daemon-record.js'

/** A usable record and whether the daemon it names is still there. */
export type LoadedDaemonRecord = Omit<Extract<DaemonRecordParseResult, { kind: 'valid' }>, 'kind'>

/**
 * A usable daemon record with its daemon's liveness, or `null` when there is
 * none — a projection of `parseDaemonRecord`, so it never reaches a verdict
 * the other commands do not. A usable record is not a running daemon: one
 * that did not stop cleanly leaves its record behind, so a caller switches on
 * `liveness` before it relays to or signals what the record names.
 *
 * `null` is what a caller reads as "no daemon is running" before it deletes
 * the record and starts a new daemon, so it is only returned where that is
 * safe: no record; one that names no daemon (writes are atomic, so text that
 * is not a record is a damaged file, not a half-written one); and one this
 * build cannot use whose daemon `daemonLiveness` finds gone.
 *
 * Three cases throw instead, each naming the file, because answering `null`
 * would start a second daemon beside one still serving:
 * - the record exists but cannot be READ;
 * - the record cannot be interpreted but its daemon is still there —
 *   likeliest one of another version, whose record this schema refuses;
 * - the record carries no token but its daemon is still there.
 * Where the platform cannot tell a process's start time, a live pid can also
 * be an unrelated process that reused it; the message says to remove the file
 * then, since only a person can tell the two apart.
 *
 * `seams` reach the liveness question, so a caller's test doubles decide it.
 */
export async function loadDaemonRecord(
  dataDir: string = DATA_DIR,
  seams: DaemonLivenessSeams = {},
): Promise<LoadedDaemonRecord | null> {
  const parsed = await parseDaemonRecord(dataDir, seams)
  const path = getDaemonRecordPath(dataDir)
  switch (parsed.kind) {
    case 'valid':
      return { record: parsed.record, liveness: parsed.liveness }
    case 'missing':
      return null
    case 'unreadable':
      throw parsed.error
    case 'malformed':
      return null
    case 'token-missing': {
      const { liveness, record } = parsed
      if (!isOccupying(liveness)) return null
      throw new Error(
        `the daemon record ${path} carries no token, and ${describeOccupant(liveness, record.pid, itsSocket(record.socketPath))}. ` +
          'Stop that daemon with the build that started it; if it is not a daemon, remove the file.',
      )
    }
    case 'uninterpretable': {
      const { liveness, recorded } = parsed
      const unlessNotADaemon =
        liveness.state === 'running' ? '; if it is not a daemon, remove the file' : ''
      throw new Error(
        `the daemon record ${path} cannot be interpreted by this version, and ${describeOccupant(liveness, recorded.pid, itsSocket(recorded.socketPath))}. ` +
          `If that is a whiteboard daemon of another version, stop it with that version${unlessNotADaemon}.`,
      )
    }
  }
}

function itsSocket(socketPath: string | undefined): string {
  return socketPath === undefined ? 'its socket' : `its socket ${socketPath}`
}

/**
 * Takes `DaemonRecordWrite`, not `DaemonRecord`: `launch` is optional only so a
 * reader can still name a daemon that predates it. A record written without it
 * would announce a build as watch-mode source.
 */
export async function saveDaemonRecord(
  record: DaemonRecordWrite,
  dataDir: string = DATA_DIR,
): Promise<void> {
  await mkdir(dataDir, { recursive: true })
  // daemon.json contains the Bearer token used to authenticate HTTP routes and the sync stream, so keep it
  // owner-only (0o600).
  await writeFileAtomic(getDaemonRecordPath(dataDir), JSON.stringify(record, null, 2), {
    mode: 0o600,
  })
}

export async function deleteDaemonRecord(dataDir: string = DATA_DIR): Promise<void> {
  await rm(getDaemonRecordPath(dataDir), { force: true })
}
