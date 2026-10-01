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
import { request as httpRequest } from 'node:http'
import {
  type ReplicaTier,
  rotateReplicaKeyResponseSchema,
  setReplicaTierResponseSchema,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/replica-key'
import type { ZodType } from 'zod'
import {
  type DaemonRecordParseResult,
  isPidAlive as defaultIsPidAlive,
  parseDaemonRecord,
} from '../daemon/daemon-record.js'
import type { DaemonRecord } from '../daemon/daemon-record-schema.js'
import {
  type DaemonRotateReplicaKeyResult,
  type DaemonSetReplicaTierResult,
  daemonRotateReplicaKeyResultSchema,
  daemonSetReplicaTierResultSchema,
} from '../shared/api-contracts/daemon-replica-posture.js'

export interface DaemonRequest {
  readonly record: DaemonRecord
  readonly method: 'POST' | 'PUT'
  readonly path: string
  readonly body?: unknown
}

interface DaemonAnswer {
  readonly status: number
  /** The JSON body, or the raw text when it is not JSON. */
  readonly body: unknown
}

/** One request over the daemon's socket under its token, answered as JSON. */
function requestDaemon(req: DaemonRequest): Promise<DaemonAnswer> {
  return new Promise((resolve, reject) => {
    const payload = req.body === undefined ? undefined : JSON.stringify(req.body)
    const outgoing = httpRequest(
      {
        socketPath: req.record.socketPath,
        method: req.method,
        path: req.path,
        headers: {
          authorization: `Bearer ${req.record.token}`,
          accept: 'application/json',
          ...(payload === undefined
            ? {}
            : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('error', reject)
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let body: unknown = text
          try {
            body = text === '' ? undefined : JSON.parse(text)
          } catch {
            // Not JSON: reported as the text it was.
          }
          resolve({ status: res.statusCode ?? 0, body })
        })
      },
    )
    outgoing.on('error', reject)
    if (payload !== undefined) outgoing.write(payload)
    outgoing.end()
  })
}

interface PostureOptions {
  dataDir: string
  workspaceId: string
  parseRecord?: (dataDir: string) => Promise<DaemonRecordParseResult>
  isPidAlive?: (pid: number) => boolean
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
  const parsed = await (options.parseRecord ?? parseDaemonRecord)(options.dataDir)
  const isAlive = options.isPidAlive ?? defaultIsPidAlive
  const { workspaceId } = options
  const none = (message: string) => ({
    refusal: refused(workspaceId, 'daemon-not-running', message),
  })
  if (parsed.kind === 'missing') return none('no daemon record found under the data directory')
  if (parsed.kind === 'malformed') return none('the daemon record cannot be read')
  if (parsed.kind === 'token-missing') return none('the daemon record carries no token')
  if (!isAlive(parsed.record.pid)) return none(`daemon pid ${parsed.record.pid} is not running`)
  return { record: parsed.record }
}

/** What a refusing daemon said, from the body shapes its routes answer with. */
function refusalMessage(body: unknown, status: number): string {
  if (body !== null && typeof body === 'object') {
    const { title, error } = body as { title?: unknown; error?: unknown }
    if (typeof title === 'string') return title
    if (typeof error === 'string') return error
  }
  return typeof body === 'string' && body !== '' ? body : `the daemon answered ${status}`
}

/**
 * Asks the daemon, and answers either the parsed 2xx body or the refusal —
 * the daemon's own, a transport failure, or a 2xx the contract refuses.
 */
async function askDaemon<T>(
  options: PostureOptions,
  req: Omit<DaemonRequest, 'record'>,
  schema: ZodType<T>,
): Promise<{ answer: T } | { refusal: Refused }> {
  const daemon = await runningDaemon(options)
  if ('refusal' in daemon) return daemon
  const { workspaceId } = options
  let answer: DaemonAnswer
  try {
    answer = await (options.request ?? requestDaemon)({ record: daemon.record, ...req })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
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
  return { answer: parsed.data }
}

export async function runDaemonRotateReplicaKey(
  options: PostureOptions,
): Promise<{ result: DaemonRotateReplicaKeyResult; exitCode: 0 | 1 }> {
  const path = `/api/workspaces/${encodeURIComponent(options.workspaceId)}/replica-key/rotate`
  const asked = await askDaemon(options, { method: 'POST', path }, rotateReplicaKeyResponseSchema)
  if ('refusal' in asked) {
    return { result: daemonRotateReplicaKeyResultSchema.parse(asked.refusal), exitCode: 1 }
  }
  return {
    result: daemonRotateReplicaKeyResultSchema.parse({
      schemaVersion: 1,
      ok: true,
      workspaceId: options.workspaceId,
      keyId: asked.answer.keyId,
    }),
    exitCode: 0,
  }
}

export async function runDaemonSetReplicaTier(
  options: PostureOptions & { tier: ReplicaTier | null },
): Promise<{ result: DaemonSetReplicaTierResult; exitCode: 0 | 1 }> {
  const path = `/api/workspaces/${encodeURIComponent(options.workspaceId)}/replica-tier`
  const asked = await askDaemon(
    options,
    { method: 'PUT', path, body: { tier: options.tier } },
    setReplicaTierResponseSchema,
  )
  if ('refusal' in asked) {
    return { result: daemonSetReplicaTierResultSchema.parse(asked.refusal), exitCode: 1 }
  }
  return {
    result: daemonSetReplicaTierResultSchema.parse({
      schemaVersion: 1,
      ok: true,
      workspaceId: options.workspaceId,
      tier: asked.answer.tier,
      effectiveTier: asked.answer.effectiveTier,
    }),
    exitCode: 0,
  }
}
