import { nanoid } from 'nanoid'
import { createDaemonIdentity } from './security/daemon-identity.js'

/**
 * How this daemon names ITSELF, in OKF §7's actor vocabulary — the one
 * `operatorInfoSchema.actor` and the trust family both speak.
 *
 * There are two answers because there are two questions, and conflating
 * them is what put a value that changes on its own into a stored row.
 */

/**
 * WHICH SESSION is editing right now. Minted once per process, so a browser
 * can tell "the same agent again" from "a second agent" — a question asked
 * and answered inside one process lifetime, which is exactly the live
 * socket's.
 *
 * Deliberately NOT the device DID: two daemons started from the same data
 * dir share an identity and would be indistinguishable on the wire.
 */
export const DAEMON_AGENT_ACTOR = `process:daemon-${nanoid(10)}`

const cache = new Map<string, string>()

/**
 * WHICH DEVICE saved this — the answer a stored version row needs, and the
 * one a per-process id cannot give: a row written before a restart and one
 * written after must name the same daemon. The device DID is derived from
 * the persisted identity keypair, so it survives restarts and says nothing
 * a public key does not already say (ADR-0035 decisions 1 and 2).
 *
 * Memoized per data dir because the fallback `ServerDeps` is deliberately
 * rebuilt per request (see `di/default-server-deps.ts`), and importing a
 * JWK keypair on every request that touches a route is a real cost for a
 * value that cannot change while the file does not. Keyed rather than a
 * single slot so a test that swaps data dirs is not served another one's.
 */
export function daemonDeviceActor(dataDir: string): string {
  const hit = cache.get(dataDir)
  if (hit !== undefined) return hit
  const did = createDaemonIdentity({ dataDir }).did
  cache.set(dataDir, did)
  return did
}
