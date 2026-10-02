/**
 * An extension that speaks another bridge protocol than the page cannot carry
 * the page's requests, and without a word about it every call fails or hangs.
 * The connect option says which side to update instead of offering a button
 * that cannot work.
 */
import { BRIDGE_PROTOCOL_VERSION } from '@kamiazya/whiteboard-daemon-client/extension-names'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { createUserSettingsStore } from '../../lib/user-settings-store.js'
import { ExtensionConnectOption } from './ExtensionConnectOption.js'

afterEach(() => {
  cleanup()
  localStorage.clear()
})

function renderWithHello(reply: { version: string; protocol?: number }) {
  render(
    <ExtensionConnectOption
      settingsStore={createUserSettingsStore()}
      hello={async () => ({ type: 'hello', ...reply })}
    />,
  )
}

const connectButton = () => screen.queryByRole('button', { name: /connect through the extension/i })

describe('ExtensionConnectOption when the extension speaks another protocol', () => {
  it('tells the person to update the extension when its protocol is older', async () => {
    renderWithHello({ version: '0.0.3', protocol: BRIDGE_PROTOCOL_VERSION - 1 })
    const notice = await screen.findByRole('alert')
    expect(notice.textContent).toMatch(/version 0\.0\.3/)
    expect(notice.textContent).toMatch(/update the extension/)
    expect(connectButton()).toBeNull()
  })

  it('tells the person to reload the page when the extension protocol is newer', async () => {
    renderWithHello({ version: '9.9.9', protocol: BRIDGE_PROTOCOL_VERSION + 1 })
    const notice = await screen.findByRole('alert')
    expect(notice.textContent).toMatch(/reload this page/)
    expect(notice.textContent).not.toMatch(/update the extension/)
    expect(connectButton()).toBeNull()
  })

  it('says the extension predates the protocol check when it sends none', async () => {
    renderWithHello({ version: '0.0.1' })
    const notice = await screen.findByRole('alert')
    expect(notice.textContent).toMatch(/predates the bridge protocol check/)
    expect(notice.textContent).toMatch(/update the extension/)
    expect(connectButton()).toBeNull()
  })

  it('offers the button and no notice when the protocols match', async () => {
    renderWithHello({ version: '1.0.0', protocol: BRIDGE_PROTOCOL_VERSION })
    expect(
      await screen.findByRole('button', { name: /connect through the extension/i }),
    ).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
