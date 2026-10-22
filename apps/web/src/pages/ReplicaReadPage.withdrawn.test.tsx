/**
 * A refusal the daemon answered directly — not through the replica-key
 * holder — withdraws the remembered copy too (ADR-0042 decision 6): the page
 * renders 'removed' and the wrapped key a passkey would open is gone, so the
 * next cold start offers no unlock. A refusal reconnecting fixes keeps it.
 */
import { forgetAllForTests } from '@kamiazya/whiteboard-daemon-client/replica-session-key'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { saveOfflinePasskey } from '../lib/replica-offline-passkey.js'
import { isReplicaReadableOffline, rememberReplicaKey } from '../lib/replica-unlock.js'
import { resetShellStatusForTests } from '../lib/shell-status-store.js'
import { replicaKeyBody } from '../test-utils/replica-key-fetch.js'
import { ReplicaReadPage } from './ReplicaReadPage.js'

const DAEMON_WS = '01ARZ3NDEKTSV4RRFFQ69G5FD0'
const DAEMON = 'http://127.0.0.1:3096'

beforeEach(async () => {
  localStorage.clear()
  forgetAllForTests()
  await rememberReplicaKey({
    daemonBaseUrl: DAEMON,
    workspaceId: DAEMON_WS,
    response: replicaKeyBody(),
    prfOutput: new Uint8Array(32).fill(7),
  })
  saveOfflinePasskey(DAEMON, DAEMON_WS, { credentialId: 'AQIDBA', prfSalt: 'BQYHCA' })
})

afterEach(() => {
  cleanup()
  resetShellStatusForTests()
  forgetAllForTests()
  localStorage.clear()
})

describe('ReplicaReadPage given a direct membership refusal', () => {
  it('drops the remembered key when the refusal withdraws access', async () => {
    render(
      <ReplicaReadPage
        workspaceId={DAEMON_WS}
        daemonBaseUrl={DAEMON}
        withheld="not_a_member"
        onReconnect={() => Promise.resolve()}
      />,
    )
    await screen.findByTestId('replica-state-removed')
    expect(isReplicaReadableOffline(DAEMON, DAEMON_WS)).toBe(false)
  })

  it('keeps the remembered key when reconnecting can fix the refusal', async () => {
    render(
      <ReplicaReadPage
        workspaceId={DAEMON_WS}
        daemonBaseUrl={DAEMON}
        withheld="requires_person_session"
        onReconnect={() => Promise.resolve()}
      />,
    )
    await screen.findByTestId('replica-state-unlockable')
    expect(isReplicaReadableOffline(DAEMON, DAEMON_WS)).toBe(true)
  })
})
