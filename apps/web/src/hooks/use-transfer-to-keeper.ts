import { useState } from 'react'
import {
  type PopupHandle,
  parseDestination,
  type SendTransferResult,
  sendTransfer,
} from '../lib/send-transfer.js'

export type TransferToKeeperState =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'done'; result: SendTransferResult }

/**
 * The sender's state: the address a person is typing, whether it names a
 * keeper this page may send to, and the one attempt in flight. The section
 * that renders it only draws.
 */
export function useTransferToKeeper(openWindow?: (url: string) => PopupHandle | null) {
  const [address, setAddress] = useState('')
  const [state, setState] = useState<TransferToKeeperState>({ kind: 'idle' })
  const destination = address.trim() === '' ? null : parseDestination(address, location.origin)
  const canSend = destination?.ok === true && state.kind !== 'sending'

  const send = (): void => {
    if (destination === null || !destination.ok) return
    setState({ kind: 'sending' })
    // Opened in THIS task, before anything is awaited: a popup blocker
    // refuses a window.open that follows an await. The record is read while
    // the destination loads.
    const payload = Promise.all([
      import('../lib/transfer-payload.js'),
      import('../lib/browser-workspace-docs.js'),
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

  return {
    address,
    setAddress,
    addressError: destination !== null && !destination.ok ? destination.reason : null,
    canSend,
    state,
    send,
  }
}
