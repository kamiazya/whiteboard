import {
  type TransferOpener,
  type TransferStage,
  useTransferHandshake,
} from '../hooks/use-transfer-handshake.js'
import type { PasskeyCredentials } from '../lib/passkey-attestation.js'

/**
 * The keeper-served /receive-transfer surface: where a workspace record
 * arriving from ANOTHER origin is accepted, at the destination keeper's own
 * address.
 *
 * Why a whole page rather than a fetch the sender makes: the hosted app's
 * `connect-src` names `'self'` and loopback only, so it cannot POST to an
 * arbitrary keeper, and enumerating every self-hosted address someone might
 * run is not a list anyone can keep. A window at the DESTINATION's origin is
 * under no such rule, and three properties follow from that rather than
 * being bolted on: the passkey asked here is one registered against THIS
 * origin (so WebAuthn's rpId is the keeper's real domain, not a loopback
 * host anything can later claim); the person sees that domain in the URL
 * bar; and the keeper's own rules are applied by the side that owns them.
 *
 * A POPUP and not an iframe, because this app sets `frame-ancestors 'none'`
 * — the receiver is this same app, so it refuses to be framed by its own
 * header. `window.open` is not governed by that.
 *
 * Nothing is accepted without an explicit press, on every render. The
 * numbers an offer carries are the SENDER's claims and are shown as such;
 * what actually merged is read back from this keeper afterwards.
 */

export interface ReceiveTransferPageProps {
  /** The R3-injected daemon token (read once by App). Absent means this page
   *  is not being served by a keeper, so accepting is impossible. */
  daemonToken?: string
  fetchFn?: typeof globalThis.fetch
  opener?: TransferOpener
  /** Test seam, as on `PromoteWorkspaceSection`: omitted, the real authenticator. */
  passkeyCredentials?: PasskeyCredentials
}

export function ReceiveTransferPage({
  daemonToken,
  fetchFn = globalThis.fetch.bind(globalThis),
  opener = globalThis.opener as TransferOpener,
  passkeyCredentials,
}: ReceiveTransferPageProps): React.JSX.Element {
  const { session, stage, targets, targetId, setTargetId, accept } = useTransferHandshake({
    hash: globalThis.location?.hash ?? '',
    daemonToken,
    fetchFn,
    opener,
    ...(passkeyCredentials === undefined ? {} : { credentials: passkeyCredentials }),
  })

  if (stage.kind === 'not-a-transfer') {
    return (
      <main className="mx-auto max-w-lg p-6" data-testid="receive-transfer">
        <h1 className="text-lg font-semibold">Nothing to receive</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          This page accepts a workspace sent from another app. Open it from there rather than
          directly.
        </p>
      </main>
    )
  }

  return (
    <main className="mx-auto max-w-lg p-6" data-testid="receive-transfer">
      <h1 className="text-lg font-semibold">Receive a workspace</h1>
      {/* The sending origin, as a TEXT node and never a link: it is the one
          fact a person needs and the one thing they should not be invited to
          follow from here. */}
      <p className="mt-2 text-sm text-muted-foreground">
        Sent from <span data-testid="receive-transfer-sender">{session?.senderOrigin}</span>
      </p>

      {stage.kind === 'waiting' && (
        <p className="mt-4 text-sm" data-testid="receive-transfer-status">
          Waiting for the workspace to arrive…
        </p>
      )}

      {stage.kind === 'offered' && (
        <OfferPanel
          documentCount={stage.offer.documentCount}
          targets={targets}
          targetId={targetId}
          onTargetChange={setTargetId}
          canAccept={daemonToken !== undefined && targetId !== ''}
          servedByKeeper={daemonToken !== undefined}
          onAccept={() => void accept()}
        />
      )}

      {stage.kind === 'accepting' && (
        <p className="mt-4 text-sm" data-testid="receive-transfer-status">
          Merging the workspace…
        </p>
      )}

      {stage.kind === 'done' && <DoneReport stage={stage} />}

      {stage.kind === 'refused' && (
        <p className="mt-4 text-sm" data-testid="receive-transfer-refused">
          {stage.reason}
        </p>
      )}
    </main>
  )
}

function OfferPanel({
  documentCount,
  targets,
  targetId,
  onTargetChange,
  canAccept,
  servedByKeeper,
  onAccept,
}: {
  documentCount: number
  targets: { workspaceId: string; displayName?: string }[]
  targetId: string
  onTargetChange: (id: string) => void
  canAccept: boolean
  servedByKeeper: boolean
  onAccept: () => void
}): React.JSX.Element {
  return (
    <>
      <p className="mt-4 text-sm" data-testid="receive-transfer-offer">
        That app says it is sending {documentCount} document{documentCount === 1 ? '' : 's'}. What
        actually arrives is reported here once it has, from this keeper's own records.
      </p>
      {/* Images are NOT carried: the bytes live in the sending browser's own
          store, outside the record, and this window is at another origin and
          cannot read it. Said before accepting rather than discovered after. */}
      <p className="mt-2 text-sm text-muted-foreground">
        Documents and their history are carried. Images are not — they stay in the sending browser,
        and any document that shows one will be missing its picture here.
      </p>
      {targets.length > 1 && (
        <label className="mt-4 block text-sm">
          Into workspace
          <select
            className="mt-1 block w-full rounded-md border px-2 py-1"
            data-testid="receive-transfer-target"
            value={targetId}
            onChange={(event) => onTargetChange(event.target.value)}
          >
            {targets.map((target) => (
              <option key={target.workspaceId} value={target.workspaceId}>
                {target.displayName ?? target.workspaceId}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="mt-4 flex gap-2">
        <button
          type="button"
          data-testid="receive-transfer-accept"
          disabled={!canAccept}
          className="rounded-md bg-primary px-3 py-1 text-sm font-medium text-primary-foreground disabled:opacity-50"
          onClick={onAccept}
        >
          Accept
        </button>
      </div>
      {!servedByKeeper && (
        <p className="mt-2 text-sm text-muted-foreground">
          This page is not being served by a keeper, so it cannot accept a workspace.
        </p>
      )}
    </>
  )
}

function DoneReport({
  stage,
}: {
  stage: Extract<TransferStage, { kind: 'done' }>
}): React.JSX.Element {
  return (
    <div className="mt-4 text-sm" data-testid="receive-transfer-done">
      <p>
        Received {stage.documentCount} document{stage.documentCount === 1 ? '' : 's'}.
      </p>
      {stage.imagesMissing > 0 && (
        <p className="mt-1 text-muted-foreground">
          {stage.imagesMissing} image{stage.imagesMissing === 1 ? '' : 's'} could not be carried and{' '}
          {stage.imagesMissing === 1 ? 'is' : 'are'} missing here.
        </p>
      )}
      {stage.shadowed.length > 0 && (
        <p className="mt-1 text-muted-foreground">
          {stage.shadowed.length} path{stage.shadowed.length === 1 ? '' : 's'} already existed here
          — both versions are kept, the earlier one marked shadowed: {stage.shadowed.join(', ')}
        </p>
      )}
    </div>
  )
}
