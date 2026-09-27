import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { BRIDGE_DAEMON_BASE_URL } from '../../lib/extension-bridge-fetch.js'
import { DaemonAddress } from './DaemonAddress.js'

afterEach(cleanup)

describe('DaemonAddress', () => {
  it('names a daemon by its host', () => {
    expect(render(<DaemonAddress baseUrl="http://127.0.0.1:3099" />).container.textContent).toBe(
      '127.0.0.1:3099',
    )
  })

  // The bridge's address is a reserved name nothing answers; showing it would
  // tell a person their data is somewhere that does not exist.
  it('names the extension for a daemon reached through it', () => {
    const { container } = render(<DaemonAddress baseUrl={BRIDGE_DAEMON_BASE_URL} />)
    expect(container.textContent).toBe('the whiteboard extension')
    expect(container.textContent).not.toContain('invalid')
  })
})
