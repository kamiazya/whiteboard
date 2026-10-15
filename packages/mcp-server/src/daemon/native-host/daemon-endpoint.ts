import { loadDaemonRecord } from '../daemon-registry.js'
import type { DaemonEndpoint } from './relay.js'

/**
 * The daemon the host relays to. A record the reader refuses — unreadable, or
 * naming a daemon still serving that this build cannot use — rejects with the
 * reader's message rather than reading as "no daemon is running", which would
 * send the person to start a second one beside it.
 */
export async function resolveDaemonEndpoint(dataDir: string): Promise<DaemonEndpoint | null> {
  const record = await loadDaemonRecord(dataDir)
  return record?.socketPath ? { socketPath: record.socketPath, token: record.token } : null
}
