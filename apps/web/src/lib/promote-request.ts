/**
 * The promote request, sent one way by every move that ends in a keeper's
 * promote route: the daemon move (`promote-workspace.ts`) and the cross-origin
 * receiver (`accept-transferred-record.ts`). The body is the compatibility
 * contract with an older keeper, whose request schema is strict, so each rule
 * about what such a keeper can read is written here once rather than in each
 * caller.
 *
 * What the callers keep is what really differs: where the snapshot comes
 * from, the move's progress and image phase, the receiver's arriving-record
 * read, and the sentences that name their keeper.
 */
import {
  promoteWorkspaceResponseSchema,
  workspaceDocumentApiUrl,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/index'
import {
  type PromoteWorkspaceRequest,
  promoteJudgedBudgetRefusalSchema,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/promotion'
import { reach } from '@kamiazya/whiteboard-daemon-client/api-contracts/read-body'
import { refusalReasonOf } from '@kamiazya/whiteboard-daemon-client/api-contracts/refusal-reason'
import { z } from 'zod'
import { unconfirmedPlanes } from './carried-planes.js'
import { listDocuments } from './daemon-api-client.js'
import { DaemonContractError, readDaemonJson } from './daemon-contract-error.js'

/** How a caller's sentences name its keeper and its operation. */
export interface PromoteWording {
  /** Opening a sentence: 'The daemon', 'This keeper'. */
  readonly subject: string
  /** Inside one: 'the daemon', 'the keeper'. */
  readonly object: string
  /** A refusal whose body states no reason. */
  readonly refused: (status: number) => string
  /** An ok answer that fails the promote contract. */
  readonly unexpected: string
}

export interface PromoteRequestOptions {
  fetch: typeof globalThis.fetch
  /** '' for a same-origin keeper. */
  keeperBaseUrl: string
  workspaceId: string
  /** The record as `doc.export({ mode: 'snapshot' })`, base64url. */
  snapshot: string
  planes: Pick<PromoteWorkspaceRequest, 'trash' | 'versions'>
  wording: PromoteWording
}

export type PromoteRequestResult =
  | {
      ok: true
      /** Paths the keeper's own post-merge list reports as contested. */
      shadowedPaths: string[]
      /** What was sent and the keeper did not report holding afterwards. */
      leftBehind: string[]
    }
  | {
      ok: false
      reason: string
      /**
       * The keeper's budget for judging carried versions, when that is what
       * it refused past: the number a re-sent move fits its versions under.
       */
      judgedLimit?: number
    }

/**
 * An empty plane is omitted rather than sent as `[]`: a keeper whose strict
 * request schema predates the planes refuses any body naming them, so a
 * workspace with nothing beside its record still moves to one.
 */
function promoteBody(
  snapshot: string,
  planes: Pick<PromoteWorkspaceRequest, 'trash' | 'versions'>,
): PromoteWorkspaceRequest {
  const { trash = [], versions = [] } = planes
  return {
    snapshot,
    ...(trash.length === 0 ? {} : { trash }),
    ...(versions.length === 0 ? {} : { versions }),
  }
}

const invalidBodySchema = z.object({ error: z.literal('invalid_body') })

/**
 * The keeper's own reason, with the one cause a person can act on named when
 * the refusal is of the planes: a keeper built before them answers a body
 * carrying any with a shape refusal that says nothing about its age.
 */
async function refused(
  res: Response,
  sent: PromoteWorkspaceRequest,
  wording: PromoteWording,
): Promise<Extract<PromoteRequestResult, { ok: false }>> {
  const { reason, body } = await refusalReasonOf(res, wording.refused(res.status))
  const budget = promoteJudgedBudgetRefusalSchema.safeParse(body)
  if (budget.success) return { ok: false, reason, judgedLimit: budget.data.limit }
  const carried = sent.trash !== undefined || sent.versions !== undefined
  if (!carried || !invalidBodySchema.safeParse(body).success) return { ok: false, reason }
  return {
    ok: false,
    reason: `${wording.subject} refused the trash and saved versions sent with the workspace (${reason}). If ${wording.object} is older than this page, update it and move again.`,
  }
}

/**
 * POSTs the record and its planes to the keeper's promote route, and reads
 * back what the keeper reports holding. A thrown fetch propagates as a
 * `FetchFailedError`: each caller turns one into its own sentence.
 */
export async function requestPromote(
  options: PromoteRequestOptions,
): Promise<PromoteRequestResult> {
  const { fetch, keeperBaseUrl, workspaceId, wording } = options
  const body = promoteBody(options.snapshot, options.planes)
  const promoteUrl = `${keeperBaseUrl}${workspaceDocumentApiUrl(workspaceId, 'promote')}`
  const res = await reach(
    fetch(promoteUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
  if (!res.ok) return refused(res, body, wording)
  // A body cut after the status line propagates as the network's failure; one
  // that arrived and broke the promote contract is the keeper's, already logged.
  let promoted: z.infer<typeof promoteWorkspaceResponseSchema>
  try {
    promoted = await readDaemonJson(promoteUrl, res, promoteWorkspaceResponseSchema)
  } catch (err) {
    if (err instanceof DaemonContractError) return { ok: false, reason: wording.unexpected }
    throw err
  }

  // The keeper's own post-merge list is what reports collisions — shadowed is
  // its projection, not something the sender can compute without knowing what
  // the target already held. A failed read-back degrades to "none reported",
  // never to a failed merge: it landed.
  const shadowedPaths = await listDocuments(fetch, keeperBaseUrl, workspaceId)
    .then((response) =>
      response.documents.filter((entry) => entry.shadowed === true).map((entry) => entry.path),
    )
    .catch(() => [])

  return {
    ok: true,
    shadowedPaths,
    leftBehind: unconfirmedPlanes(body, promoted, wording.object),
  }
}
