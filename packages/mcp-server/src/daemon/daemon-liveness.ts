// Whether the daemon a daemon.json names is still running — answered here
// once for every reader of the record, because each reader that chose its own
// check chose a different one, and `daemon doctor` called a pid another
// process had taken "running" beside a `daemon status` that said otherwise.
//
// The pid's start time decides on the plain path (`shared/process-identity`).
// When it says the pid belongs to a process that started after the record,
// the record's socket is asked before that is believed: `/proc/stat`'s btime
// moves with a stepped wall clock while a process's start ticks do not, so a
// forward step of a few seconds makes a live daemon look as if it started
// after its own record. Believing that would delete the record of a daemon
// still serving, and the next start would fail on its socket. The daemon's
// runtime status, asked under the record's token, names its pid; naming the
// recorded one makes it the writer whatever /proc says. The socket is asked
// on that ambiguous path alone, so the plain path costs no connection.

import { runtimeStatusApiUrl } from '@kamiazya/whiteboard-daemon-client/api-contracts/daemon-urls'
import { z } from 'zod'
import { type ProcessIdentitySeams, recordedProcess } from '../shared/process-identity.js'
import type { RecordedDaemon } from './daemon-record-schema.js'
import {
  type DaemonAnswer,
  DaemonNoAnswerError,
  type DaemonRequest,
  requestDaemon,
} from './daemon-request.js'

/**
 * - `running`: the pid is the process that wrote the record.
 * - `unconfirmed`: the pid's start time says it is not the writer, yet a
 *   daemon answers on the record's socket without confirming that pid. Something
 *   is serving there, so nothing may treat the record as a leftover — and
 *   nothing may signal the pid either. `servingPid` is the pid the answer
 *   named, when it was a runtime status at all: a person has to find that
 *   process to stop it, and the record cannot tell them.
 * - `pid-reused`: the pid is alive, started after the record, and nothing
 *   accepts a connection on the record's socket. A socket that accepts and
 *   then stays silent past the ask's timeout is `unconfirmed`: something is
 *   serving it, and a daemon busy on a large write is the likeliest thing.
 * - `dead`: no process has the pid.
 */
export type DaemonLiveness =
  | { readonly state: 'running' }
  | { readonly state: 'unconfirmed'; readonly servingPid?: number }
  | { readonly state: 'pid-reused' }
  | { readonly state: 'dead' }

/**
 * The pid that answered on the record's socket where it was not the record's,
 * as the field a result carries it in — absent in every other case, so a
 * result spreads it without a branch of its own.
 */
export function servingPidOf(liveness: DaemonLiveness): { servingPid?: number } {
  return liveness.state === 'unconfirmed' && liveness.servingPid !== undefined
    ? { servingPid: liveness.servingPid }
    : {}
}

export interface DaemonLivenessSeams extends ProcessIdentitySeams {
  readonly request?: (req: DaemonRequest) => Promise<DaemonAnswer>
}

/**
 * All of the runtime status this asks for. Only the pid decides, so a daemon
 * of another version whose status this build's full contract would refuse is
 * still recognised when it names the recorded pid; and a pid no process can
 * have is no pid at all, so it never becomes a `servingPid`.
 */
const answeredPidSchema = z.object({ pid: z.number().int().positive() })

/**
 * Long enough for a daemon busy on a large write to answer, short enough that
 * a command run against a socket nobody serves does not appear to hang.
 */
const SOCKET_ASK_TIMEOUT_MS = 1_500

export async function daemonLiveness(
  record: RecordedDaemon,
  { request = requestDaemon, ...identitySeams }: DaemonLivenessSeams = {},
): Promise<DaemonLiveness> {
  const writtenAtMs = record.startedAt === undefined ? Number.NaN : Date.parse(record.startedAt)
  const identity = recordedProcess(record.pid, writtenAtMs, identitySeams)
  if (identity === 'writer') return { state: 'running' }
  if (identity === 'dead') return { state: 'dead' }
  const { socketPath } = record
  if (socketPath === undefined) return { state: 'pid-reused' }
  let answer: DaemonAnswer
  try {
    answer = await request({
      record: { socketPath, ...(record.token === undefined ? {} : { token: record.token }) },
      method: 'GET',
      path: runtimeStatusApiUrl(),
      timeoutMs: SOCKET_ASK_TIMEOUT_MS,
    })
  } catch (err) {
    // Only a connection nobody accepted means nothing serves the socket.
    return err instanceof DaemonNoAnswerError ? { state: 'unconfirmed' } : { state: 'pid-reused' }
  }
  const status = answeredPidSchema.safeParse(answer.body)
  if (answer.status !== 200 || !status.success) return { state: 'unconfirmed' }
  if (status.data.pid === record.pid) return { state: 'running' }
  return { state: 'unconfirmed', servingPid: status.data.pid }
}
