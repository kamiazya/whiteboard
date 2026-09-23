import type { DiscoveredDaemon } from '../../lib/daemon-discovery.js'
import type { IdentityChallengeResult } from '../../lib/daemon-identity-pin.js'
import { isImeComposingKeydown } from '../../lib/ime-keydown.js'

// Docs are not served from apps/web (no /docs route), so the banner links to
// the source-of-truth GitHub blob rather than fabricating a local route.
export const HOW_TO_CONNECT_URL =
  'https://github.com/kamiazya/whiteboard/blob/main/docs/how-to/connect-to-local-daemon.md'

// Phrased as a possibility, not a claim: the same stall also happens from a
// plain network timeout with no permission prompt involved. The permission
// read settles that afterwards, but this hint is shown WHILE the sweep is
// still outstanding, when the prompt (if any) is unanswered and there is
// still nothing to distinguish the two cases by.
export const LNA_HINT_TEXT =
  'This is taking a while — your browser may be asking for permission to reach local devices. Check for a permission prompt.'

/**
 * What the Local Network Access permission needs SAID, in the two states
 * where saying it changes what the person can do.
 *
 * `explain` comes before the check, not after: the browser's prompt is
 * triggered BY the request and a denial is remembered, so an unexplained
 * prompt is a question the user usually gets exactly one chance to answer
 * well. It is a live region rather than a dialog because it is inline and
 * non-blocking, and an unfocused dialog is announced by nothing at all.
 *
 * `blocked` offers no retry: the permission cannot be re-requested from
 * script once denied — only browser settings can undo it — so a button here
 * would be a lie about that.
 */
export function LocalNetworkGateNotice({
  connectGate,
  onContinue,
  onDismiss,
}: {
  connectGate: string
  onContinue: () => void
  onDismiss: () => void
}) {
  return (
    <>
      {connectGate === 'explain' && (
        // Said before the check, not after: the browser's prompt is triggered
        // BY the request, and a denial is remembered, so an unexplained
        // prompt is a question the user usually gets exactly one chance to
        // answer well.
        <span
          data-testid="lna-explainer"
          // A live region rather than role="dialog": this is inline and
          // non-blocking, and an unfocused dialog is announced by nothing at
          // all — a screen reader user would meet the browser's permission
          // prompt without ever hearing the explanation meant to precede it.
          role="status"
          className="flex flex-wrap items-center gap-1.5 rounded-md border px-2 py-1 text-xs text-muted-foreground"
        >
          Your browser is about to ask whether this site may reach devices on your local network.
          That is how it connects to the daemon running on your own machine — nothing leaves your
          computer.
          <button
            type="button"
            data-testid="lna-explainer-continue"
            onClick={onContinue}
            className="font-medium underline"
          >
            Continue
          </button>
          <button
            type="button"
            data-testid="lna-explainer-cancel"
            onClick={onDismiss}
            className="font-medium underline"
          >
            Not now
          </button>
        </span>
      )}
      {connectGate === 'blocked' && (
        // No check is offered here on purpose: the permission cannot be
        // re-requested from script once it is denied, so a retry button would
        // do nothing but fail again. Only browser settings can undo it.
        <span
          data-testid="lna-blocked"
          role="alert"
          className="flex flex-wrap items-center gap-1.5 rounded-md border px-2 py-1 text-xs text-amber-700"
        >
          Your browser is blocking this site from reaching your local network, so the daemon cannot
          be found however the port is set. Allow local network access for this site in your
          browser's site settings, then check again.{' '}
          <a
            href={HOW_TO_CONNECT_URL}
            target="_blank"
            rel="noreferrer"
            className="font-medium underline"
          >
            How to connect
          </a>
        </span>
      )}
    </>
  )
}

/**
 * Why the check the USER asked for came back empty. Only ever shown after a
 * manual check — the silent auto-probe on a loopback mount must not spawn
 * failure copy nobody asked for, which is what the call site gates on.
 *
 * Each explanation names a different thing to DO, which is why they are
 * separate rather than one "could not connect".
 */
export function ProbeFailureNotice({
  failureExplanation,
  pageOriginScheme,
  baseUrl,
  onConnectAnyway,
}: {
  failureExplanation: string | null
  pageOriginScheme: string
  baseUrl: string
  onConnectAnyway: () => void
}) {
  return (
    <>
      {failureExplanation === 'permission-unanswered' && (
        <span
          data-testid="daemon-check-unanswered-notice"
          className="text-xs text-muted-foreground"
        >
          The browser asked for permission to reach your local network and the request was left
          unanswered. Check again and choose Allow.
        </span>
      )}
      {failureExplanation === 'not-a-daemon' && (
        <span
          data-testid="daemon-check-wrong-server-notice"
          className="text-xs text-muted-foreground"
        >
          Something is running on that port, but it is not a whiteboard daemon. Check the port
          number.
        </span>
      )}
      {(failureExplanation === 'unreachable' || failureExplanation === 'unclear') && (
        // A CORS rejection (daemon running but this origin not in its
        // WHITEBOARD_ALLOWED_WEB_ORIGINS) is indistinguishable from
        // daemon-absent at the fetch layer, so the hosted-origin copy stays
        // conditional ("if yours is running…") per the honesty discipline
        // above. Loopback origins need no allowlist entry, so they get the
        // plain not-found message.
        <span data-testid="daemon-check-failed-notice" className="text-xs text-muted-foreground">
          {pageOriginScheme === 'https' ? (
            <>
              No daemon reachable from this origin. If yours is running, approving it on the
              daemon's consent page grants this origin access (a top-level navigation is not subject
              to the CORS block that hides the daemon from the check) —{' '}
              <button type="button" onClick={onConnectAnyway} className="font-medium underline">
                connect anyway
              </button>
              . Only approve a daemon you started yourself, or see{' '}
              <a
                href={HOW_TO_CONNECT_URL}
                target="_blank"
                rel="noreferrer"
                className="font-medium underline"
              >
                how to connect
              </a>
              .
            </>
          ) : (
            <>No daemon found at {baseUrl}.</>
          )}
        </span>
      )}
    </>
  )
}

/**
 * Name the port yourself. Always offered, never gated on a failed check:
 * naming a port is the primary way in now that there is no port scan to
 * stumble on one, so gating it on "nothing found" would leave a user
 * connected to the WRONG daemon unable to name the right one, and a user
 * whose dismissals hid every candidate unable to name anything at all.
 */
export function PortField({
  portInput,
  setPortInput,
  portError,
  onCheck,
}: {
  portInput: string
  setPortInput: (next: string) => void
  portError: string | null
  onCheck: () => void
}) {
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <label htmlFor="daemon-port-input">Running on another port?</label>
      <input
        id="daemon-port-input"
        data-testid="daemon-port-input"
        type="text"
        inputMode="numeric"
        enterKeyHint="go"
        value={portInput}
        onChange={(event) => setPortInput(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || isImeComposingKeydown(event.nativeEvent)) return
          onCheck()
        }}
        placeholder="3099"
        className="w-16 rounded border px-1 py-0.5"
        aria-describedby={portError ? 'daemon-port-error' : undefined}
      />
      <button
        type="button"
        data-testid="daemon-port-connect"
        onClick={onCheck}
        className="font-medium underline"
      >
        Check
      </button>
      {portError && (
        <span id="daemon-port-error" role="alert" className="text-amber-700">
          {portError}
        </span>
      )}
    </span>
  )
}

/**
 * The one-responder banner, and the three things it can honestly say about
 * WHO answered.
 *
 * Only a daemon that was pinned before AND answers its own challenge is
 * called verified; a pinned one whose challenge FAILED drops to the cautious
 * copy rather than keeping the label, because a daemon we once pinned must
 * be able to answer for itself. Everything else is "a server responded",
 * which is all the probe can actually establish.
 */
export function SingleDaemonBanner({
  detectedBaseUrl,
  isPairedTarget,
  identityStatus,
  hasStoredTarget,
  onUseHere,
  onForget,
  onDismiss,
}: {
  detectedBaseUrl: string
  isPairedTarget: boolean
  identityStatus: IdentityChallengeResult | null
  hasStoredTarget: boolean
  onUseHere: () => void
  onForget: () => void
  onDismiss: () => void
}) {
  return (
    <div
      data-testid="daemon-detected-banner"
      className="flex shrink-0 items-center justify-between gap-2 bg-muted px-3 py-1.5 text-xs text-muted-foreground"
    >
      <span>
        {isPairedTarget && identityStatus === 'verified' ? (
          <>
            A whiteboard daemon is running on this machine at {detectedBaseUrl} (identity verified).
          </>
        ) : isPairedTarget && identityStatus !== 'failed' ? (
          <>A whiteboard daemon is running on this machine at {detectedBaseUrl}.</>
        ) : (
          <>
            A server responded at {detectedBaseUrl} (unverified — approve it on its own page to
            confirm it is your daemon).
          </>
        )}
      </span>
      <button
        type="button"
        onClick={onUseHere}
        className="rounded-md border px-3 py-1 font-medium transition-colors hover:bg-accent"
      >
        Use here
      </button>
      <a
        href={HOW_TO_CONNECT_URL}
        target="_blank"
        rel="noreferrer"
        className="font-medium underline"
        aria-label="Learn more about connecting a daemon"
      >
        Learn more
      </a>
      {hasStoredTarget && (
        <button
          type="button"
          onClick={onForget}
          className="shrink-0 rounded px-1.5 py-0.5 font-medium hover:bg-background/60"
        >
          Forget this daemon
        </button>
      )}
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="shrink-0 rounded px-1.5 py-0.5 font-medium hover:bg-background/60"
      >
        Dismiss
      </button>
    </div>
  )
}

/**
 * Several responders, which is the local norm rather than an oddity — a
 * dynamic port per dev worktree. Each row pairs IN PLACE first: leaving for
 * the daemon's own origin is the fallback, not the only way through
 * (hosted-app-first).
 *
 * Every row says "unverified" once, at the top: none of them has been
 * challenged, and repeating it per row would read as a per-daemon verdict.
 */
export function DaemonPicker({
  found,
  onUseHere,
  onDismiss,
}: {
  found: readonly DiscoveredDaemon[]
  onUseHere: (baseUrl: string) => void
  onDismiss: () => void
}) {
  return (
    <div
      data-testid="daemon-picker"
      className="flex shrink-0 flex-wrap items-center gap-2 bg-muted px-3 py-1.5 text-xs text-muted-foreground"
    >
      <span>{found.length} servers responded on local ports (unverified).</span>
      {found.map((daemon) => (
        // Pair IN PLACE first: leaving for the daemon's own origin is
        // the fallback, not the only way through (hosted-app-first).
        <span key={daemon.instanceId} className="flex items-center gap-1">
          <span className="font-mono">{daemon.baseUrl.replace(/^https?:\/\//, '')}</span>
          <button
            type="button"
            onClick={() => onUseHere(daemon.baseUrl)}
            aria-label={`Use ${daemon.baseUrl} here`}
            className="rounded-md border px-2 py-0.5 font-medium transition-colors hover:bg-accent"
          >
            Use here
          </button>
        </span>
      ))}
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="shrink-0 rounded px-1.5 py-0.5 font-medium hover:bg-background/60"
      >
        Dismiss
      </button>
    </div>
  )
}

/**
 * The check the user asks for, and what is said while it runs.
 *
 * The button is disabled for the WHOLE window between a sweep starting and
 * it settling, so a second click during the sweep is impossible rather than
 * silently deduped by the in-flight map one layer down. The Local Network
 * Access hint only appears beside a running check, where it explains a
 * prompt the person is looking at.
 */
export function ManualCheckControl({
  checking,
  showLnaHint,
  onCheck,
}: {
  checking: boolean
  showLnaHint: boolean
  onCheck: () => void
}) {
  return (
    <>
      <button
        type="button"
        onClick={onCheck}
        disabled={checking}
        aria-busy={checking}
        className="rounded-md border px-3 py-1 text-xs font-medium transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
      >
        Check for a daemon
      </button>
      {checking && (
        <>
          <span role="status" className="text-xs text-muted-foreground">
            Checking…
          </span>
          {showLnaHint && <span className="text-xs text-muted-foreground">{LNA_HINT_TEXT}</span>}
        </>
      )}
    </>
  )
}
