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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { acceptTransferredRecord } from '../lib/accept-transferred-record.js'
import { CROSS_ORIGIN_TRANSFER_PROTOCOL } from '../lib/cross-origin-transfer-protocol.js'
import { listWorkspaces } from '../lib/daemon-api-client.js'
import { createDaemonFetch } from '../lib/daemon-auth-fetch.js'
import type { PasskeyCredentials } from '../lib/passkey-attestation.js'
import {
  type OfferedTransfer,
  openTransferSession,
  postTransferResult,
  readOfferedTransfer,
  type TransferSession,
} from '../lib/receive-transfer.js'

export type TransferStage =
  /** No usable fragment: this window was not opened by a transfer. */
  | { kind: 'not-a-transfer' }
  /** Listening, having told the opener so. */
  | { kind: 'waiting' }
  | { kind: 'offered'; offer: Extract<OfferedTransfer, { kind: 'offer' }> }
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
  targets: { workspaceId: string; displayName?: string }[]
  targetId: string
  setTargetId: (id: string) => void
  accept: () => Promise<void>
}

export function useTransferHandshake({
  hash,
  daemonToken,
  fetchFn,
  opener,
  credentials,
}: {
  hash: string
  daemonToken?: string
  fetchFn: typeof globalThis.fetch
  opener: TransferOpener
  /** Test seam; production asks this origin's real authenticator. */
  credentials?: PasskeyCredentials
}): TransferHandshake {
  const [session] = useState<TransferSession | null>(() => openTransferSession(hash))
  const [stage, setStage] = useState<TransferStage>(() =>
    openTransferSession(hash) === null ? { kind: 'not-a-transfer' } : { kind: 'waiting' },
  )
  const keeperFetch = useKeeperFetch(daemonToken, fetchFn)
  const { targets, targetId, setTargetId } = useKeeperWorkspaceTargets({
    enabled: session !== null,
    keeperFetch,
  })
  // Held in a ref as well as in state: the accept handler must act on the
  // bytes it was given, and a re-render between the offer and the press must
  // not be able to hand it a different snapshot.
  const offered = useRef<Extract<OfferedTransfer, { kind: 'offer' }> | null>(null)

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

  useEffect(() => {
    if (session === null) return
    const onMessage = (event: MessageEvent): void => {
      const read = readOfferedTransfer(session, { origin: event.origin, data: event.data })
      // `ignored` is the common case and deliberately silent — see
      // receive-transfer.ts on why a wrong origin is not an error.
      if (read.kind === 'ignored') return
      if (read.kind === 'refused') {
        setStage({ kind: 'refused', reason: read.reason })
        return
      }
      offered.current = read
      setStage({ kind: 'offered', offer: read })
    }
    globalThis.addEventListener('message', onMessage)
    return () => globalThis.removeEventListener('message', onMessage)
  }, [session])

  const accept = useCallback(async () => {
    const offer = offered.current
    if (offer === null || session === null || keeperFetch === null || targetId === '') return
    setStage({ kind: 'accepting' })
    const outcome = await acceptTransferredRecord({
      fetch: keeperFetch,
      workspaceId: targetId,
      snapshot: offer.snapshot,
      ...(credentials === undefined ? {} : { credentials }),
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
      postTransferResult(opener, session, {
        ok: true,
        workspaceId: targetId,
        promotedDocumentIds: outcome.promotedDocumentIds,
        shadowedPaths: outcome.shadowedPaths,
        attested: outcome.attested,
        imagesMissing: outcome.imagesMissing,
      })
    }
  }, [session, keeperFetch, targetId, opener, credentials])

  return { session, stage, targets, targetId, setTargetId, accept }
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
  /** Null when this page is not served by a keeper: there is nothing to list. */
  keeperFetch: typeof globalThis.fetch | null
}): {
  targets: { workspaceId: string; displayName?: string }[]
  targetId: string
  setTargetId: (id: string) => void
} {
  const [targets, setTargets] = useState<{ workspaceId: string; displayName?: string }[]>([])
  const [targetId, setTargetId] = useState('')
  useEffect(() => {
    if (!enabled || keeperFetch === null) return
    void listWorkspaces(keeperFetch, '')
      .then((response) => {
        setTargets(response.workspaces)
        setTargetId((current) => current || (response.workspaces[0]?.workspaceId ?? ''))
      })
      // A keeper that cannot list its own workspaces cannot accept into one;
      // the accept control stays disabled and the page says why.
      .catch(() => setTargets([]))
  }, [enabled, keeperFetch])
  return { targets, targetId, setTargetId }
}

/**
 * Every request this page makes is to its OWN keeper, and the credential
 * reaches it through the one seam that attaches it (`createDaemonFetch`,
 * daemon-auth-seam.test.ts) — never a header set here. Null when the page is
 * not served by a keeper: there is then nothing it may ask.
 */
function useKeeperFetch(
  daemonToken: string | undefined,
  fetchFn: typeof globalThis.fetch,
): typeof globalThis.fetch | null {
  return useMemo(
    () =>
      daemonToken === undefined
        ? null
        : createDaemonFetch(globalThis.location.origin, daemonToken, fetchFn),
    [daemonToken, fetchFn],
  )
}
