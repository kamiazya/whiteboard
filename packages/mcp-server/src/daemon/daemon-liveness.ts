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
//
// Where no start time can be read at all (no /proc), a live pid proves
// nothing. On Unix the socket sits in a directory only its owner can enter, so
// whatever serves it is this user's and the pid is taken as the writer. A
// Windows named pipe has no such directory: once a daemon dies without
// removing its record, another OS user can create a pipe under the recorded
// name. So a pipe is asked to prove it holds the record's token
// (`../shared/endpoint-proof.ts`) without being sent it, and only a proof makes
// it `running`.

import { runtimeStatusApiUrl } from '@kamiazya/whiteboard-daemon-client/api-contracts/daemon-urls'
import { z } from 'zod'
import {
  endpointProofResponseSchema,
  endpointProofUrl,
  isEndpointProof,
  newEndpointProofNonce,
} from '../shared/endpoint-proof.js'
import { type ProcessIdentitySeams, recordedProcess } from '../shared/process-identity.js'
import type { RecordedDaemon } from './daemon-record-schema.js'
import {
  type DaemonAnswer,
  DaemonNoAnswerError,
  type DaemonRequest,
  requestDaemon,
} from './daemon-request.js'
import { isNamedPipe } from './daemon-socket.js'

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

type Ask = (req: DaemonRequest) => Promise<DaemonAnswer>

/**
 * The record's socket's answer, or the verdict its silence gives: only a
 * connection nobody accepted means nothing serves the socket.
 */
async function askSocket(
  request: Ask,
  req: DaemonRequest,
): Promise<{ answer: DaemonAnswer } | { liveness: DaemonLiveness }> {
  try {
    return { answer: await request(req) }
  } catch (err) {
    return {
      liveness:
        err instanceof DaemonNoAnswerError ? { state: 'unconfirmed' } : { state: 'pid-reused' },
    }
  }
}

/**
 * Whether the pipe's server holds `token`, asked WITHOUT the token: sending it
 * is exactly what a server that has not proved itself must not receive.
 */
async function provenPipe(
  request: Ask,
  socketPath: string,
  token: string | undefined,
): Promise<DaemonLiveness> {
  const nonce = newEndpointProofNonce()
  const asked = await askSocket(request, {
    record: { socketPath },
    method: 'GET',
    path: endpointProofUrl(nonce),
    timeoutMs: SOCKET_ASK_TIMEOUT_MS,
  })
  if ('liveness' in asked) return asked.liveness
  const body = endpointProofResponseSchema.safeParse(asked.answer.body)
  const proven =
    asked.answer.status === 200 &&
    body.success &&
    token !== undefined &&
    (await isEndpointProof(token, nonce, body.data.proof))
  return proven ? { state: 'running' } : { state: 'unconfirmed' }
}

/** Whether the socket names the recorded pid, asked under the record's token. */
async function confirmedPid(request: Ask, record: RecordedDaemon, socketPath: string) {
  const asked = await askSocket(request, {
    record: { socketPath, ...(record.token === undefined ? {} : { token: record.token }) },
    method: 'GET',
    path: runtimeStatusApiUrl(),
    timeoutMs: SOCKET_ASK_TIMEOUT_MS,
  })
  if ('liveness' in asked) return asked.liveness
  const status = answeredPidSchema.safeParse(asked.answer.body)
  if (asked.answer.status !== 200 || !status.success) return { state: 'unconfirmed' } as const
  if (status.data.pid === record.pid) return { state: 'running' } as const
  return { state: 'unconfirmed', servingPid: status.data.pid } as const
}

export async function daemonLiveness(
  record: RecordedDaemon,
  { request = requestDaemon, ...identitySeams }: DaemonLivenessSeams = {},
): Promise<DaemonLiveness> {
  const writtenAtMs = record.startedAt === undefined ? Number.NaN : Date.parse(record.startedAt)
  const identity = recordedProcess(record.pid, writtenAtMs, identitySeams)
  if (identity === 'writer') return { state: 'running' }
  if (identity === 'dead') return { state: 'dead' }
  const { socketPath } = record
  if (identity === 'unknown') {
    if (socketPath === undefined || !isNamedPipe(socketPath)) return { state: 'running' }
    return provenPipe(request, socketPath, record.token)
  }
  if (socketPath === undefined) return { state: 'pid-reused' }
  return confirmedPid(request, record, socketPath)
}
