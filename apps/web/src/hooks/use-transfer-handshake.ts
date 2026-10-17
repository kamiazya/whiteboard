/**
 * The receiving side's handshake as state: what this window knows, what has
 * arrived, and what accepting it did.
 *
 * A hook rather than logic inside the page, for the reason `app-web.md`'s
 * layer order exists — the page is presentation, and the sequence here
 * (announce, listen, offer, accept, report) is the part worth testing without
 * rendering anything. The gate it defers to is `lib/receive-transfer.ts`,
 * where the order of the origin, shape and nonce checks is the design.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { acceptTransferredRecord } from '../lib/accept-transferred-record.js'
import { CROSS_ORIGIN_TRANSFER_PROTOCOL } from '../lib/cross-origin-transfer-protocol.js'
import { listWorkspaces } from '../lib/daemon-api-client.js'
import {
  type OfferedTransfer,
  openTransferSession,
  postTransferDecline,
  postTransferResult,
  readOfferedTransfer,
  type TransferSession,
} from '../lib/receive-transfer.js'
import type { WorkspaceIdentity } from '../lib/workspace-handle.js'

export type TransferStage =
  /** No usable fragment: this window was not opened by a transfer. */
  | { kind: 'not-a-transfer' }
  /** Listening, having told the opener so. */
  | { kind: 'waiting' }
  /**
   * An offer arrived from the origin the fragment named — which can be ANY
   * web origin, since a server-mode keeper accepts a transfer from whoever
   * sends one. Nothing is acceptable until the person says they started it.
   */
  | { kind: 'confirming'; offer: Extract<OfferedTransfer, { kind: 'offer' }> }
  | { kind: 'offered'; offer: Extract<OfferedTransfer, { kind: 'offer' }> }
  /** The person did not recognise the transfer; the opener was told so and nothing more. */
  | { kind: 'declined' }
  | { kind: 'accepting' }
  | { kind: 'done'; documentCount: number; imagesMissing: number; shadowed: string[] }
  | { kind: 'refused'; reason: string }

/** The window this page replies to. Production is `window.opener`. */
export type TransferOpener = {
  postMessage: (message: unknown, targetOrigin: string) => void
} | null

export interface TransferHandshake {
  session: TransferSession | null
  stage: TransferStage
  targets: WorkspaceIdentity[]
  /** This keeper would not list its workspaces — for a server-mode keeper,
   *  the person is not signed in here. */
  targetsUnavailable: boolean
  targetId: string
  setTargetId: (id: string) => void
  /** The person started this transfer: show the offer as acceptable. */
  confirm: () => void
  decline: () => void
  accept: () => Promise<void>
}

export function useTransferHandshake({
  hash,
  fetchFn,
  opener,
}: {
  hash: string
  /** Same-origin, so the signed-in person's session cookie is the credential. */
  fetchFn: typeof globalThis.fetch
  opener: TransferOpener
}): TransferHandshake {
  const [session] = useState<TransferSession | null>(() => openTransferSession(hash))
  const [stage, setStage] = useState<TransferStage>(() =>
    openTransferSession(hash) === null ? { kind: 'not-a-transfer' } : { kind: 'waiting' },
  )
  const { targets, targetsUnavailable, targetId, setTargetId } = useKeeperWorkspaceTargets({
    enabled: session !== null,
    keeperFetch: fetchFn,
  })
  const { confirm, decline, confirmedOffer } = useOfferDecision(session, opener, setStage)

  // A message posted to a window that has not run its script yet is simply
  // LOST, and there is no event for "the other side is ready" other than the
  // other side saying so.
  useEffect(() => {
    if (session === null || !opener) return
    opener.postMessage(
      { type: 'transfer-ready', protocol: CROSS_ORIGIN_TRANSFER_PROTOCOL, nonce: session.nonce },
      session.senderOrigin,
    )
  }, [session, opener])

  const accept = useCallback(async () => {
    const offer = confirmedOffer()
    if (offer === null || session === null || targetId === '') return
    setStage({ kind: 'accepting' })
    const outcome = await acceptTransferredRecord({
      fetch: fetchFn,
      workspaceId: targetId,
      ...offer,
    })
    if (!outcome.ok) {
      setStage({ kind: 'refused', reason: outcome.reason })
      if (opener) postTransferResult(opener, session, { ok: false, reason: outcome.reason })
      return
    }
    setStage({
      kind: 'done',
      documentCount: outcome.promotedDocumentIds.length,
      imagesMissing: outcome.imagesMissing.length,
      shadowed: outcome.shadowedPaths,
    })
    if (opener) {
      // The keeper's own read-back, whole: ids, collisions, missing images
      // and the carried planes it did not report holding.
      postTransferResult(opener, session, { ...outcome, workspaceId: targetId })
    }
  }, [session, fetchFn, targetId, opener, confirmedOffer])

  return {
    session,
    stage,
    targets,
    targetsUnavailable,
    targetId,
    setTargetId,
    confirm,
    decline,
    accept,
  }
}

type Offer = Extract<OfferedTransfer, { kind: 'offer' }>

/**
 * What has arrived and what the person decided about it. Held in a ref as
 * well as in state: accept must act on the bytes the person confirmed, and a
 * re-render between the offer and the press must not hand it a different
 * snapshot or a stale decision.
 */
function useOfferDecision(
  session: TransferSession | null,
  opener: TransferOpener,
  setStage: (stage: TransferStage) => void,
): { confirm: () => void; decline: () => void; confirmedOffer: () => Offer | null } {
  const held = useRef({ offer: null as Offer | null, confirmed: false, declined: false })

  useEffect(() => {
    if (session === null) return
    const onMessage = (event: MessageEvent): void => {
      // A declined attempt is over; re-offering does not get to ask again.
      if (held.current.declined) return
      const read = readOfferedTransfer(session, { origin: event.origin, data: event.data })
      // `ignored` is the common case and deliberately silent — see
      // receive-transfer.ts on why a wrong origin is not an error.
      if (read.kind === 'ignored') return
      if (read.kind === 'offer') held.current = { offer: read, confirmed: false, declined: false }
      setStage(
        read.kind === 'offer'
          ? { kind: 'confirming', offer: read }
          : { kind: 'refused', reason: read.reason },
      )
    }
    globalThis.addEventListener('message', onMessage)
    return () => globalThis.removeEventListener('message', onMessage)
  }, [session, setStage])

  const confirm = useCallback(() => {
    const { offer, declined } = held.current
    if (offer === null || declined) return
    held.current = { offer, confirmed: true, declined: false }
    setStage({ kind: 'offered', offer })
  }, [setStage])

  const decline = useCallback(() => {
    if (held.current.offer === null || held.current.declined || session === null) return
    held.current = { offer: null, confirmed: false, declined: true }
    setStage({ kind: 'declined' })
    if (opener) postTransferDecline(opener, session)
  }, [session, opener, setStage])

  const confirmedOffer = useCallback(() => (held.current.confirmed ? held.current.offer : null), [])
  return { confirm, decline, confirmedOffer }
}

/**
 * Which workspaces THIS keeper holds, and which one an arriving record
 * merges into. A promote merges into an EXISTING workspace (ADR-0023), so
 * somebody has to say which — and that is a separate question from what has
 * arrived, which is why it is a separate hook rather than a third effect
 * inside the handshake.
 */
function useKeeperWorkspaceTargets({
  enabled,
  keeperFetch,
}: {
  enabled: boolean
  keeperFetch: typeof globalThis.fetch
}): {
  targets: WorkspaceIdentity[]
  targetsUnavailable: boolean
  targetId: string
  setTargetId: (id: string) => void
} {
  const [targets, setTargets] = useState<WorkspaceIdentity[]>([])
  const [targetsUnavailable, setTargetsUnavailable] = useState(false)
  const [targetId, setTargetId] = useState('')
  useEffect(() => {
    if (!enabled) return
    void listWorkspaces(keeperFetch, '')
      .then((response) => {
        // No default: the person names the workspace a stranger's data
        // lands in, rather than accepting whichever happens to list first.
        setTargets(response.workspaces)
      })
      // A keeper that cannot list its own workspaces cannot accept into one;
      // the accept control stays disabled and the page says why.
      .catch(() => {
        setTargets([])
        setTargetsUnavailable(true)
      })
  }, [enabled, keeperFetch])
  return { targets, targetsUnavailable, targetId, setTargetId }
}
