/**
 * What a `#wb=` pairing link shows while it is being turned into a
 * connection (see lib/link-pairing.ts).
 *
 * It exists so the page does not render the BROWSER's own workspaces in the
 * meantime: those belong to a different keeper, and on the consent path the
 * user would watch them appear and then vanish again.
 */
export interface LinkPairingPendingProps {
  daemonBaseUrl: string
  failed: boolean
  onWorkInBrowser: () => void
}

export function LinkPairingPending({
  daemonBaseUrl,
  failed,
  onWorkInBrowser,
}: LinkPairingPendingProps) {
  return (
    <div className="flex h-dvh items-center justify-center p-6">
      {failed ? (
        <div role="alert" className="max-w-md text-center text-sm">
          <p className="font-medium">Couldn't reach that daemon.</p>
          <p className="mt-2 text-muted-foreground">
            The pairing link points at {daemonBaseUrl}, which did not answer. Check the daemon is
            running, then open the link again.
          </p>
          <button
            type="button"
            onClick={onWorkInBrowser}
            className="mt-4 rounded-md border px-4 py-1.5 text-sm font-medium hover:bg-accent"
          >
            Work in this browser instead
          </button>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Connecting to the daemon…</p>
      )}
    </div>
  )
}
