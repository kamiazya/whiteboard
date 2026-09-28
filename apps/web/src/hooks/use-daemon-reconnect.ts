import { useCallback, useEffect, useRef, useState } from 'react'
import { isBridgeDaemon } from '../lib/bridge-address.js'
import type { ExtensionConnection } from '../lib/extension-connection.js'
import type { ProviderState } from '../lib/provider.js'
import type { UserSettingsStore } from '../lib/user-settings-store.js'

/**
 * Which remembered daemon a cold load reconnects to, or `null`.
 *
 * ADR-0050: a local daemon is reached through the extension and nothing else,
 * so only a daemon remembered at the bridge's address is asked. A loopback
 * address a settings record still holds is left alone — reconnecting to it
 * would be the loopback path this app no longer takes, and the person
 * reconnects through the extension instead.
 */
export function storedDaemonForReconnect(gate: {
  providerKind: ProviderState['kind']
  storedBaseUrl: string | undefined
}): string | null {
  if (gate.providerKind !== 'browser') return null
  if (gate.storedBaseUrl === undefined || !isBridgeDaemon(gate.storedBaseUrl)) return null
  return gate.storedBaseUrl
}

type Connected = Extract<ExtensionConnection, { status: 'connected' }>

export interface DaemonReconnect {
  /** The daemon this page reconnected to, or `null`. */
  readonly connection: Connected | null
  /**
   * The remembered daemon did not answer. Held so the render can offer the
   * replica read (ADR-0023) instead of silently landing on the browser's own
   * workspaces.
   */
  readonly renewal: 'unreachable' | null
  /** Re-run by ReplicaReadPage's Reconnect action, through the same gate. */
  readonly attemptRenewal: () => Promise<void>
  /**
   * A reconnection is allowed but has not answered. Nothing downstream may
   * conclude the browser keeps this session while it is open.
   */
  readonly awaitingDaemonRenewal: boolean
}

/**
 * Reconnects, on a cold load, to the daemon a person connected through the
 * extension before (ADR-0050): there is no pairing to renew, so reconnecting
 * is asking whether it answers.
 */
export function useDaemonReconnect(input: {
  providerKind: ProviderState['kind']
  userSettingsStore: UserSettingsStore
}): DaemonReconnect {
  const [connection, setConnection] = useState<Connected | null>(null)
  const [renewal, setRenewal] = useState<'unreachable' | null>(null)

  const target = storedDaemonForReconnect({
    providerKind: input.providerKind,
    storedBaseUrl: input.userSettingsStore.load().storage.daemonBaseUrl,
  })

  const attemptRenewal = useCallback(async () => {
    if (target === null) return
    // Loaded here rather than at the top: a cold load with nothing to
    // reconnect should not pay for the bridge.
    const { connectThroughExtension } = await import('../lib/extension-connection.js')
    const result = await connectThroughExtension()
    if (result.status === 'connected') {
      setRenewal(null)
      setConnection(result)
      return
    }
    setRenewal('unreachable')
  }, [target])

  useOnMount(attemptRenewal)

  return {
    connection,
    renewal,
    attemptRenewal,
    awaitingDaemonRenewal: target !== null && renewal === null,
  }
}

/**
 * Runs `effect` exactly once per mount, ref-guarded against StrictMode's
 * double render.
 *
 * `effect` is deliberately NOT a dependency: its identity changes with the
 * values it closes over, and re-running for that would defeat the guard. The
 * caller's decision is over mount-time facts.
 */
function useOnMount(effect: () => void | Promise<void>): void {
  const ran = useRef(false)
  useEffect(() => {
    if (ran.current) return
    ran.current = true
    void effect()
  }, [])
}
