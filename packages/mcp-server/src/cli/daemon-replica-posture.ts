/**
 * The operator's entry point to a workspace's read-plane REPLICA POSTURE:
 * rotating its content key (ADR-0042's 2026-09-21 rotation addendum) and
 * setting or clearing its replica tier (the tier addendum beside it). Both
 * are decisions at the `runtime:admin` bar, and both existed only as HTTP
 * routes on the daemon's owner-only socket (ADR-0050) — so the remedy for a
 * key suspected compromised was `curl --unix-socket` with the daemon token
 * read out of `daemon.json` by hand.
 *
 * The CLI asks the RUNNING daemon rather than opening the store itself,
 * because the key store is the daemon's: a second writer on the same SQLite
 * row would race `keyFor`, and a rotation the daemon did not perform is one
 * its live sessions never hear about. The daemon record supplies both the
 * socket and the token, exactly as the native host reaches it.
 */
import {
  replicaKeyRotateApiUrl,
  replicaTierApiUrl,
  workspacesApiUrl,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/daemon-urls'
import { listWorkspacesResponseSchema } from '@kamiazya/whiteboard-daemon-client/api-contracts/document'
import {
  type ReplicaTier,
  rotateReplicaKeyResponseSchema,
  type setReplicaTierRequestSchema,
  setReplicaTierResponseSchema,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/replica-key'
import { describeThrown } from '@kamiazya/whiteboard-model'
import { resolveWorkspaceHandle } from '@kamiazya/whiteboard-ports'
import { apiErrorReason } from '@kamiazya/whiteboard-server-core'
import type { ZodType, z } from 'zod'
import type { DaemonLivenessSeams } from '../daemon/daemon-liveness.js'
import {
  type DaemonRecordParseResult,
  describeOccupant,
  describeUnconfirmed,
  parseDaemonRecord,
} from '../daemon/daemon-record.js'
import type { DaemonRecord } from '../daemon/daemon-record-schema.js'
import { type DaemonAnswer, type DaemonRequest, requestDaemon } from '../daemon/daemon-request.js'
import {
  type DaemonRotateReplicaKeyResult,
  type DaemonSetReplicaTierResult,
  daemonRotateReplicaKeyResultSchema,
  daemonSetReplicaTierResultSchema,
} from '../shared/api-contracts/daemon-replica-posture.js'

interface PostureOptions {
  dataDir: string
  workspaceId: string
  parseRecord?: (dataDir: string, seams?: DaemonLivenessSeams) => Promise<DaemonRecordParseResult>
  isPidAlive?: (pid: number) => boolean
  /** When a pid's process started; null where the platform cannot say. */
  processStartMs?: (pid: number) => number | null
  request?: (req: DaemonRequest) => Promise<DaemonAnswer>
}

type Refused = Extract<DaemonRotateReplicaKeyResult, { ok: false }>

function refused(
  workspaceId: string,
  reason: Refused['reason'],
  message: string,
  status?: number,
): Refused {
  return {
    schemaVersion: 1,
    ok: false,
    workspaceId,
    reason,
    ...(status === undefined ? {} : { status }),
    message,
  }
}

/** The running daemon's record, or why there is none to ask. */
async function runningDaemon(
  options: PostureOptions,
): Promise<{ record: DaemonRecord } | { refusal: Refused }> {
  const seams = {
    isAlive: options.isPidAlive,
    startMs: options.processStartMs,
    ...(options.request === undefined ? {} : { request: options.request }),
  }
  const parsed = await (options.parseRecord ?? parseDaemonRecord)(options.dataDir, seams)
  const { workspaceId } = options
  const none = (message: string) => ({
    refusal: refused(workspaceId, 'daemon-not-running', message),
  })
  if (parsed.kind === 'missing') return none('no daemon record found under the data directory')
  if (parsed.kind === 'unreadable') {
    return none(`the daemon record cannot be read: ${parsed.error.message}`)
  }
  if (parsed.kind === 'malformed') return none('the daemon record is malformed')
  if (parsed.kind === 'token-missing') return none('the daemon record carries no token')
  if (parsed.kind === 'uninterpretable') {
    return none(
      `the daemon record cannot be interpreted by this version, and ${describeOccupant(parsed.liveness, parsed.recorded.pid)}; stop it with the version that started it`,
    )
  }
  const { liveness, record } = parsed
  const { pid } = record
  if (liveness.state === 'dead') return none(`daemon pid ${pid} is not running`)
  if (liveness.state === 'pid-reused') {
    return none(`daemon pid ${pid} now belongs to another process`)
  }
  if (liveness.state === 'unconfirmed') {
    return none(
      `${describeUnconfirmed(liveness, pid, 'the recorded socket')}, which the record names`,
    )
  }
  return { record }
}

/**
 * What a refusing daemon said. `apiErrorReason` is the one reader of an
 * error body — a hand-rolled one here answered the error CODE where the
 * route had written a sentence beside it — and a body outside the contract
 * is reported as the text it was, or as the status alone.
 */
function refusalMessage(body: unknown, status: number): string {
  const reason = apiErrorReason(body)
  if (reason !== undefined) return reason
  return typeof body === 'string' && body !== '' ? body : `the daemon answered ${status}`
}

/**
 * The canonical id for a handle the operator typed. The daemon's posture
 * routes take canonical ids only, while every other surface (and the server
 * commands) accepts the segment an operator sees in a URL (ADR-0019); the
 * listing is asked rather than the store opened, for the reason the module
 * header gives. A handle the listing does not resolve, or a listing this
 * version cannot read, is passed through as typed so the daemon's own answer
 * stays the authority on what exists.
 */
async function canonicalWorkspaceId(
  options: PostureOptions,
  record: DaemonRecord,
): Promise<string> {
  try {
    const answer = await (options.request ?? requestDaemon)({
      record,
      method: 'GET',
      path: workspacesApiUrl(),
    })
    const listing = listWorkspacesResponseSchema.safeParse(answer.body)
    if (answer.status !== 200 || !listing.success) return options.workspaceId
    return (
      resolveWorkspaceHandle(listing.data.workspaces, options.workspaceId)?.workspaceId ??
      options.workspaceId
    )
  } catch {
    // The request that follows reports an unreachable daemon in its own words.
    return options.workspaceId
  }
}

/**
 * Asks the daemon, and answers either the parsed 2xx body or the refusal —
 * the daemon's own, a transport failure, or a 2xx the contract refuses.
 */
async function askDaemon<T>(
  options: PostureOptions,
  req: { method: 'POST' | 'PUT'; pathFor: (workspaceId: string) => string; body?: unknown },
  schema: ZodType<T>,
): Promise<{ answer: T; workspaceId: string } | { refusal: Refused }> {
  const daemon = await runningDaemon(options)
  if ('refusal' in daemon) return daemon
  const workspaceId = await canonicalWorkspaceId(options, daemon.record)
  let answer: DaemonAnswer
  try {
    answer = await (options.request ?? requestDaemon)({
      record: daemon.record,
      method: req.method,
      path: req.pathFor(workspaceId),
      ...(req.body === undefined ? {} : { body: req.body }),
    })
  } catch (err) {
    const message = describeThrown(err)
    return { refusal: refused(workspaceId, 'unreachable', message) }
  }
  if (answer.status < 200 || answer.status >= 300) {
    const message = refusalMessage(answer.body, answer.status)
    return { refusal: refused(workspaceId, 'refused', message, answer.status) }
  }
  const parsed = schema.safeParse(answer.body)
  if (!parsed.success) {
    const message = `the daemon answered ${answer.status} with a body this version cannot read`
    return { refusal: refused(workspaceId, 'malformed-response', message, answer.status) }
  }
  return { answer: parsed.data, workspaceId }
}

export async function runDaemonRotateReplicaKey(
  options: PostureOptions,
): Promise<{ result: DaemonRotateReplicaKeyResult; exitCode: 0 | 1 }> {
  const asked = await askDaemon(
    options,
    {
      method: 'POST',
      pathFor: replicaKeyRotateApiUrl,
    },
    rotateReplicaKeyResponseSchema,
  )
  if ('refusal' in asked) {
    return { result: daemonRotateReplicaKeyResultSchema.parse(asked.refusal), exitCode: 1 }
  }
  return {
    result: daemonRotateReplicaKeyResultSchema.parse({
      schemaVersion: 1,
      ok: true,
      workspaceId: asked.workspaceId,
      keyId: asked.answer.keyId,
    }),
    exitCode: 0,
  }
}

export async function runDaemonSetReplicaTier(
  options: PostureOptions & { tier: ReplicaTier | null },
): Promise<{ result: DaemonSetReplicaTierResult; exitCode: 0 | 1 }> {
  const asked = await askDaemon(
    options,
    {
      method: 'PUT',
      pathFor: replicaTierApiUrl,
      body: { tier: options.tier } satisfies z.infer<typeof setReplicaTierRequestSchema>,
    },
    setReplicaTierResponseSchema,
  )
  if ('refusal' in asked) {
    return { result: daemonSetReplicaTierResultSchema.parse(asked.refusal), exitCode: 1 }
  }
  return {
    result: daemonSetReplicaTierResultSchema.parse({
      schemaVersion: 1,
      ok: true,
      workspaceId: asked.workspaceId,
      tier: asked.answer.tier,
      effectiveTier: asked.answer.effectiveTier,
    }),
    exitCode: 0,
  }
}
