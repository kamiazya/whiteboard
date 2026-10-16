import type { DaemonLivenessSeams } from '../daemon-liveness.js'
import { describeUnconfirmed, opensSentence } from '../daemon-record.js'
import { getDaemonRecordPath, loadDaemonRecord } from '../daemon-registry.js'
import type { DaemonEndpoint } from './relay.js'

/**
 * The daemon the host relays to. A record the reader refuses — unreadable, or
 * naming a daemon still serving that this build cannot use — rejects with the
 * reader's message rather than reading as "no daemon is running", which would
 * send the person to start a second one beside it.
 *
 * A record outlives a daemon that did not stop cleanly, so a valid one is
 * relayed to only while the liveness it is loaded with says its daemon is
 * there: relaying to a gone daemon's socket answers a socket error, where the
 * person needs to be told to start one. Only a daemon confirmed as the
 * record's own is relayed to: an unconfirmed one may be another daemon on that
 * socket, which the record's token does not describe, so it is refused with
 * the record's sentence instead.
 */
export async function resolveDaemonEndpoint(
  dataDir: string,
  seams: DaemonLivenessSeams = {},
): Promise<DaemonEndpoint | null> {
  const loaded = await loadDaemonRecord(dataDir, seams)
  if (loaded === null) return null
  const { record, liveness } = loaded
  if (liveness.state === 'unconfirmed') {
    const occupant = opensSentence(describeUnconfirmed(liveness, record.pid, record.socketPath))
    throw new Error(
      `${occupant}, which ${getDaemonRecordPath(dataDir)} names. Stop the process serving that socket, then start the daemon again.`,
    )
  }
  if (liveness.state !== 'running') return null
  return { socketPath: record.socketPath, token: record.token }
}
