/**
 * ADR-0050: with the whiteboard extension installed, connecting to the local
 * daemon is one action — no pairing page, no port to find.
 */

import { BRIDGE_PROTOCOL_VERSION } from '@kamiazya/whiteboard-daemon-client/extension-names'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BRIDGE_DAEMON_BASE_URL } from '../../lib/bridge-address.js'
import { createUserSettingsStore } from '../../lib/user-settings-store.js'
import { ExtensionConnectOption } from './ExtensionConnectOption.js'

const MATCHING_HELLO = {
  type: 'hello',
  version: '1.0.0',
  protocol: BRIDGE_PROTOCOL_VERSION,
} as const

afterEach(() => {
  cleanup()
  localStorage.clear()
})

describe('ExtensionConnectOption', () => {
  // ADR-0050: a local daemon is reached through the extension and nothing
  // else, so a browser without it is told how to get it.
  it('says how to get the extension where it is not installed', async () => {
    render(
      <ExtensionConnectOption settingsStore={createUserSettingsStore()} hello={async () => null} />,
    )
    const link = await screen.findByRole('link', { name: 'How to connect a daemon' })
    expect(link.getAttribute('href')).toContain('docs/how-to/connect-to-local-daemon.md')
    expect(screen.getByText(/install the whiteboard extension/i)).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  // The answer to "is it there?" is either instant or a timeout, so nothing
  // is said until it arrives: saying "install it" first would flash at every
  // person who has.
  it('says nothing while the extension is still being asked', () => {
    const { container } = render(
      <ExtensionConnectOption
        settingsStore={createUserSettingsStore()}
        hello={() => new Promise<null>(() => {})}
      />,
    )
    expect(container.innerHTML).toBe('')
  })

  it('offers only the connect button where the extension answers', async () => {
    render(
      <ExtensionConnectOption
        settingsStore={createUserSettingsStore()}
        hello={async () => MATCHING_HELLO}
      />,
    )
    expect(
      await screen.findByRole('button', { name: /connect through the extension/i }),
    ).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'How to connect a daemon' })).toBeNull()
  })

  // A probe outliving its page holds a listener and a timer on a window that
  // may already be gone; unmounting has to call it off.
  it('calls off the presence probe when it unmounts', async () => {
    let asked: AbortSignal | undefined
    const hello = vi.fn((signal: AbortSignal) => {
      asked = signal
      return new Promise<null>(() => {})
    })
    const { unmount } = render(
      <ExtensionConnectOption settingsStore={createUserSettingsStore()} hello={hello} />,
    )
    await vi.waitFor(() => expect(hello).toHaveBeenCalled())
    expect(asked?.aborted).toBe(false)
    unmount()
    expect(asked?.aborted).toBe(true)
  })

  // Remembered, then reopened: the cold load reconnects through the same
  // path every later visit takes, and switching keeper is a reopen the
  // person asked for rather than a swap under them.
  it('connects through the extension, remembers it, and reopens', async () => {
    const settingsStore = createUserSettingsStore()
    const reopen = vi.fn()
    render(
      <ExtensionConnectOption
        settingsStore={settingsStore}
        hello={async () => MATCHING_HELLO}
        connect={async () => ({
          status: 'connected',
          daemonBaseUrl: BRIDGE_DAEMON_BASE_URL,
          token: '',
        })}
        reopen={reopen}
      />,
    )
    fireEvent.click(await screen.findByRole('button', { name: /connect through the extension/i }))

    await vi.waitFor(() => expect(reopen).toHaveBeenCalledOnce())
    expect(settingsStore.load().storage.daemonBaseUrl).toBe(BRIDGE_DAEMON_BASE_URL)
  })

  it('says how to start the daemon when none answers', async () => {
    const settingsStore = createUserSettingsStore()
    const reopen = vi.fn()
    render(
      <ExtensionConnectOption
        settingsStore={settingsStore}
        hello={async () => MATCHING_HELLO}
        connect={async () => ({ status: 'none' })}
        reopen={reopen}
      />,
    )
    fireEvent.click(await screen.findByRole('button', { name: /connect through the extension/i }))

    // The exact command, not a substring of it: the CLI's own dispatcher
    // judges this text in mcp-server's docs-commands guard, which a prefix
    // match would not.
    await vi.waitFor(() =>
      expect(screen.getByRole('status').querySelector('code')?.textContent).toBe(
        'whiteboard daemon run',
      ),
    )
    expect(reopen).not.toHaveBeenCalled()
    expect(settingsStore.load().storage.daemonBaseUrl).toBeUndefined()
  })
})
