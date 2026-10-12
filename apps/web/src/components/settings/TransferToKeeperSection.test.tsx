/**
 * What the section tells a person the other keeper will ask of them. The
 * receiver authorises the merge with the session signed in there and an
 * explicit Accept (`ReceiveTransferPage`); no keeper pins a passkey, so a
 * lede promising one sends a person looking for a step that never comes.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { TransferToKeeperSection } from './TransferToKeeperSection.js'

describe('TransferToKeeperSection', () => {
  it('says the other keeper asks for its sign-in and an Accept, not a passkey', () => {
    render(<TransferToKeeperSection openWindow={() => null} />)
    const lede = screen.getByText(/opens in its own window/)
    expect(lede.textContent).toMatch(/sign in/)
    expect(lede.textContent).toMatch(/Accept/)
    expect(lede.textContent).not.toMatch(/passkey/i)
  })
})
