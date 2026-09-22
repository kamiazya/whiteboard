import { useState } from 'react'
import {
  type PopupHandle,
  parseDestination,
  type SendTransferResult,
  sendTransfer,
} from '../../lib/send-transfer.js'
import { Button } from '../ui/button.js'

/**
 * Sending this browser's workspace to ANOTHER keeper — a self-hosted server
 * or a SaaS — by its address, with no daemon in between (user decision,
 * 2026-09-22).
 *
 * The move itself happens in a window at the destination's own origin, which
 * asks that keeper's passkey and merges there; this section opens it, hands
 * over the record, and reports what came back. See `send-transfer.ts` for why
 * a window rather than a request, and `receive-transfer.ts` for the other end.
 *
 * Two things are said rather than left to be discovered: images stay in this
 * browser (their bytes live outside the record, where the destination cannot
 * reach), and this browser KEEPS its copy — the daemon move deletes the local
 * copy only after reading every document back from the destination, and a
 * keeper at another origin is not something this page can read back from.
 */
export function TransferToKeeperSection({
  openWindow,
}: {
  /** Test seam; production uses `window.open`. */
  openWindow?: (url: string) => PopupHandle | null
}): React.JSX.Element {
  const [address, setAddress] = useState('')
  const [state, setState] = useState<
    { kind: 'idle' } | { kind: 'sending' } | { kind: 'done'; result: SendTransferResult }
  >({ kind: 'idle' })
  const destination = address.trim() === '' ? null : parseDestination(address, location.origin)

  const send = (): void => {
    if (destination === null || !destination.ok) return
    setState({ kind: 'sending' })
    // Opened in THIS task, before anything is awaited: a popup blocker
    // refuses a window.open that follows an await. The record is read while
    // the destination loads.
    const payload = Promise.all([
      import('../../lib/transfer-payload.js'),
      import('../../lib/browser-workspace-docs.js'),
    ]).then(([{ readTransferPayload }, { BrowserWorkspaceDocs }]) =>
      readTransferPayload(new BrowserWorkspaceDocs()),
    )
    void sendTransfer({
      keeperBaseUrl: destination.keeperBaseUrl,
      senderOrigin: location.origin,
      payload,
      ...(openWindow === undefined ? {} : { openWindow }),
    }).then((result) => setState({ kind: 'done', result }))
  }

  return (
    <section aria-label="Send to another keeper" className="space-y-2">
      <h3 className="text-sm font-medium">Send this workspace to another keeper</h3>
      <p className="text-xs text-muted-foreground">
        A self-hosted server or a hosted service, by its address. It opens in its own window, where
        you confirm with that keeper’s passkey. Images stay in this browser, and this browser keeps
        its copy.
      </p>
      <label className="block text-xs">
        Keeper address
        <input
          type="url"
          data-testid="transfer-keeper-address"
          className="mt-1 block w-full rounded-md border px-2 py-1 text-sm"
          placeholder="https://whiteboard.example.com"
          value={address}
          onChange={(event) => setAddress(event.target.value)}
        />
      </label>
      {destination !== null && !destination.ok && (
        <p className="text-xs text-muted-foreground" data-testid="transfer-keeper-address-error">
          {destination.reason}
        </p>
      )}
      <Button
        type="button"
        size="sm"
        data-testid="transfer-send"
        disabled={destination === null || !destination.ok || state.kind === 'sending'}
        onClick={send}
      >
        {state.kind === 'sending' ? 'Waiting for the keeper…' : 'Send'}
      </Button>
      {/* Mounted before it speaks (polite-live-region.test.ts): a status
          region that arrives with its message is announced inconsistently,
          so this one is always in the tree and only its text changes. */}
      <p className="text-xs" role="status" aria-live="polite" data-testid="transfer-report">
        {state.kind === 'done' ? reportFor(state.result) : ''}
      </p>
    </section>
  )
}

function reportFor(result: SendTransferResult): string {
  if (!result.ok) return result.reason
  const count = result.promotedDocumentIds.length
  const images = result.imagesMissing?.length ?? 0
  const parts = [`Sent ${count} document${count === 1 ? '' : 's'}.`]
  if (images > 0) parts.push(`${images} image${images === 1 ? '' : 's'} stayed in this browser.`)
  if (result.shadowedPaths.length > 0) {
    const n = result.shadowedPaths.length
    parts.push(`${n} path${n === 1 ? '' : 's'} already existed there and both versions were kept.`)
  }
  parts.push('This browser still has its copy.')
  return parts.join(' ')
}
