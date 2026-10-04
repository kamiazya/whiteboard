// @vitest-environment jsdom
/**
 * ADR-0050: with the whiteboard extension installed, connecting to the
 * daemon is offered wherever the app says there is no daemon — not only
 * inside a document's workspace popover, which a person reaches only after
 * making a document they will then leave behind in the browser.
 */
import { BRIDGE_PROTOCOL_VERSION } from '@kamiazya/whiteboard-daemon-client/extension-names'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserIndexPage } from '../../pages/BrowserIndexPage.js'
import { SettingsPage } from '../../pages/SettingsPage.js'
import { BrowserStoreDouble } from '../../test-utils/browser-store-fixture.js'

// Absent-extension behaviour is ExtensionConnectOption's own test; here the
// question is only where it is placed.
vi.mock('../../lib/bridge-loader.js', () => ({
  extensionHello: async () => ({
    type: 'hello',
    version: '1.0.0',
    protocol: BRIDGE_PROTOCOL_VERSION,
  }),
  bridgeFetch: vi.fn(),
}))

afterEach(cleanup)

const connectButton = () => screen.findByRole('button', { name: 'Connect through the extension' })

describe('connecting through the extension', () => {
  it('is offered where Settings says no daemon is connected', async () => {
    render(
      <MemoryRouter initialEntries={['/settings/connections']}>
        <SettingsPage />
      </MemoryRouter>,
    )
    expect(await connectButton()).toBeTruthy()
  })

  it('is offered on the empty landing page of a browser-kept workspace', async () => {
    const store = new BrowserStoreDouble()
    render(
      <MemoryRouter initialEntries={['/']}>
        <BrowserIndexPage
          index={store.index}
          loro={store.loro}
          pointer={store.pointer}
          clock={store.clock}
          onOpenDocument={vi.fn()}
        />
      </MemoryRouter>,
    )
    await screen.findByText('What will you make first?')
    expect(await connectButton()).toBeTruthy()
  })
})
