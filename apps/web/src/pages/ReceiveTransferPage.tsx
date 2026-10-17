import {
  type TransferOpener,
  type TransferStage,
  useTransferHandshake,
} from '../hooks/use-transfer-handshake.js'
import { type WorkspaceIdentity, workspaceLabel } from '../lib/workspace-handle.js'

/**
 * The keeper-served /receive-transfer surface: where a workspace record
 * arriving from ANOTHER origin is accepted, at the destination keeper's own
 * address.
 *
 * Why a whole page rather than a fetch the sender makes: the hosted app's
 * `connect-src` names `'self'` and the font catalogue only, so it cannot
 * POST to an arbitrary keeper, and enumerating every self-hosted address
 * someone might run is not a list anyone can keep. A window at the DESTINATION's origin is
 * under no such rule, and three properties follow from that rather than
 * being bolted on: the request carries the session of the person signed in
 * HERE (a server-mode keeper's host-only cookie, ADR-0047), so the keeper
 * authorises the merge exactly as it authorises any other write by them; the
 * person sees that domain in the URL bar; and the keeper's own rules are
 * applied by the side that owns them. Only a server-mode keeper serves this
 * page: the local daemon serves no web origin at all (ADR-0050).
 *
 * A POPUP and not an iframe, because this app sets `frame-ancestors 'none'`
 * — the receiver is this same app, so it refuses to be framed by its own
 * header. `window.open` is not governed by that.
 *
 * Nothing is accepted without an explicit press, on every render. The
 * numbers an offer carries are the SENDER's claims and are shown as such;
 * what actually merged is read back from this keeper afterwards.
 *
 * ANY web origin may open this page and offer a transfer, and that is
 * deliberate: a self-hosted app has an address nobody can list in advance.
 * So the first thing an offer meets is a question naming that origin, and
 * no Accept control exists until the person says they started it — a page
 * that opened this window on its own gets a decline and nothing else. The
 * target workspace is never preselected for the same reason: where a
 * stranger's record would land is the person's choice, not the list order.
 */

export interface ReceiveTransferPageProps {
  /** Same-origin to this keeper, so the session cookie rides along. */
  fetchFn?: typeof globalThis.fetch
  opener?: TransferOpener
}

export function ReceiveTransferPage({
  fetchFn = globalThis.fetch.bind(globalThis),
  opener = globalThis.opener as TransferOpener,
}: ReceiveTransferPageProps): React.JSX.Element {
  const {
    session,
    stage,
    targets,
    targetsUnavailable,
    targetId,
    setTargetId,
    confirm,
    decline,
    accept,
  } = useTransferHandshake({
    hash: globalThis.location?.hash ?? '',
    fetchFn,
    opener,
  })

  if (stage.kind === 'not-a-transfer') return <NothingToReceive />

  return (
    <main className="mx-auto max-w-lg p-6" data-testid="receive-transfer">
      <h1 className="text-lg font-semibold">Receive a workspace</h1>
      {/* The sending origin, as a TEXT node and never a link: it is the one
          fact a person needs and the one thing they should not be invited to
          follow from here. */}
      <p className="mt-2 text-sm text-muted-foreground">
        Sent from <span data-testid="receive-transfer-sender">{session?.senderOrigin}</span>
      </p>

      <StatusLine stage={stage} />

      {stage.kind === 'confirming' && (
        <ConfirmSender
          senderOrigin={session?.senderOrigin ?? ''}
          onConfirm={confirm}
          onDecline={decline}
        />
      )}

      {stage.kind === 'offered' && (
        <OfferPanel
          documentCount={stage.offer.documentCount}
          targets={targets}
          targetId={targetId}
          onTargetChange={setTargetId}
          canAccept={targetId !== ''}
          onAccept={() => void accept()}
          onDecline={decline}
        />
      )}

      {(stage.kind === 'confirming' || stage.kind === 'offered') && targetsUnavailable && (
        <SignInNotice />
      )}

      {stage.kind === 'done' && <DoneReport stage={stage} />}
    </main>
  )
}

function NothingToReceive(): React.JSX.Element {
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

/** The one-sentence stages: what the page is doing, or why it stopped. */
function StatusLine({ stage }: { stage: TransferStage }): React.JSX.Element | null {
  switch (stage.kind) {
    case 'waiting':
      return (
        <p className="mt-4 text-sm" data-testid="receive-transfer-status">
          Waiting for the workspace to arrive…
        </p>
      )
    case 'accepting':
      return (
        <p className="mt-4 text-sm" data-testid="receive-transfer-status">
          Merging the workspace…
        </p>
      )
    case 'declined':
      return (
        <p className="mt-4 text-sm" data-testid="receive-transfer-declined">
          Declined. Nothing was merged, and the other app was told only that you declined. You can
          close this window.
        </p>
      )
    case 'refused':
      return (
        <p className="mt-4 text-sm" data-testid="receive-transfer-refused">
          {stage.reason}
        </p>
      )
    default:
      return null
  }
}

// Signing in HERE would navigate this window away and lose the handshake in
// its fragment, so the person signs in elsewhere and the sender sends again.
function SignInNotice(): React.JSX.Element {
  return (
    <p className="mt-2 text-sm text-muted-foreground" data-testid="receive-transfer-sign-in">
      Sign in to this keeper in another tab, then send the workspace again from the other app.
    </p>
  )
}

function ConfirmSender({
  senderOrigin,
  onConfirm,
  onDecline,
}: {
  senderOrigin: string
  onConfirm: () => void
  onDecline: () => void
}): React.JSX.Element {
  return (
    <section className="mt-4 rounded-md border p-4" data-testid="receive-transfer-confirm">
      <h2 className="text-base font-semibold">Did you start this transfer?</h2>
      <p className="mt-2 text-sm">A workspace is being offered by</p>
      {/* A text node, never a link, for the reason the line above says. */}
      <p
        className="mt-1 break-all font-mono text-base font-semibold"
        data-testid="receive-transfer-confirm-sender"
      >
        {senderOrigin}
      </p>
      <p className="mt-2 text-sm text-muted-foreground">
        Continue only if you sent it from that address yourself. Any site can open this page, so if
        you do not recognise it, decline and nothing is merged.
      </p>
      <div className="mt-4 flex gap-2">
        <button
          type="button"
          data-testid="receive-transfer-confirm-yes"
          className="rounded-md bg-primary px-3 py-1 text-sm font-medium text-primary-foreground"
          onClick={onConfirm}
        >
          I started it
        </button>
        <DeclineButton onDecline={onDecline} />
      </div>
    </section>
  )
}

function DeclineButton({ onDecline }: { onDecline: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid="receive-transfer-decline"
      className="rounded-md border px-3 py-1 text-sm font-medium"
      onClick={onDecline}
    >
      Decline
    </button>
  )
}

function OfferPanel({
  documentCount,
  targets,
  targetId,
  onTargetChange,
  canAccept,
  onAccept,
  onDecline,
}: {
  documentCount: number
  targets: WorkspaceIdentity[]
  targetId: string
  onTargetChange: (id: string) => void
  canAccept: boolean
  onAccept: () => void
  onDecline: () => void
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
      {targets.length > 0 && (
        <TargetPicker targets={targets} targetId={targetId} onTargetChange={onTargetChange} />
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
        <DeclineButton onDecline={onDecline} />
      </div>
    </>
  )
}

// Always shown, and starting on a disabled empty choice: where the record
// lands is named by the person, never taken from the list order.
function TargetPicker({
  targets,
  targetId,
  onTargetChange,
}: {
  targets: WorkspaceIdentity[]
  targetId: string
  onTargetChange: (id: string) => void
}): React.JSX.Element {
  return (
    <label className="mt-4 block text-sm">
      Into workspace
      <select
        className="mt-1 block w-full rounded-md border px-2 py-1"
        data-testid="receive-transfer-target"
        value={targetId}
        onChange={(event) => onTargetChange(event.target.value)}
      >
        <option value="" disabled>
          Choose a workspace
        </option>
        {targets.map((target) => (
          <option key={target.workspaceId} value={target.workspaceId}>
            {workspaceLabel(target)}
          </option>
        ))}
      </select>
    </label>
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
