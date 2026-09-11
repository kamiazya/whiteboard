import {
  readDaemonTokenOnce,
  resetTokenStoreForTests,
} from '@kamiazya/whiteboard-daemon-client/api-client'
import { cleanup, render, screen } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { encodeDaemonConnectionFragment } from '../lib/daemon-connection-payload.js'
import { resetDaemonConnectionForTests, useDaemonConnection } from './useDaemonConnection.js'

afterEach(cleanup)

function Consumer() {
  const result = useDaemonConnection()
  return <div data-testid="result">{JSON.stringify(result)}</div>
}

function setHash(hash: string) {
  window.history.replaceState(null, '', `${window.location.pathname}${hash}`)
}

describe('useDaemonConnection', () => {
  beforeEach(() => {
    resetDaemonConnectionForTests()
    resetTokenStoreForTests()
    setHash('')
  })

  it('returns {status:"none"} when there is no fragment', () => {
    render(<Consumer />)
    const result = JSON.parse(screen.getByTestId('result').textContent ?? '{}')
    expect(result).toEqual({ status: 'none' })
  })

  // 'paired' means "a link asked for this daemon", never "this page can
  // talk to it": the fragment names a target and carries no credential, and
  // App turns it into a real connection through the pairing-grant flow.
  it('returns {status:"paired"} with the link target and NO token', () => {
    setHash(
      encodeDaemonConnectionFragment({
        baseUrl: 'http://127.0.0.1:3000',
        workspaceId: 'ws1',
        path: 'canvas-a',
      }),
    )
    render(<Consumer />)
    const result = JSON.parse(screen.getByTestId('result').textContent ?? '{}')
    expect(result.status).toBe('paired')
    expect(result.payload).toEqual({
      baseUrl: 'http://127.0.0.1:3000',
      workspaceId: 'ws1',
      path: 'canvas-a',
    })
    expect(readDaemonTokenOnce()).toBeNull()
  })

  // A link minted by an older daemon embeds that daemon's full-authority
  // token. It must be REFUSED rather than parsed, and the fragment stripped
  // from history either way — the credential is live until rotated, so a
  // link left in the address bar is a link still worth stealing.
  it('refuses a legacy credential-carrying fragment and strips it', () => {
    const legacy = btoa(
      JSON.stringify({
        baseUrl: 'http://127.0.0.1:3000',
        authMode: 'bootstrap',
        bootstrapToken: 'sekrit-token',
      }),
    )
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
    setHash(`#wb=${legacy}`)
    render(<Consumer />)
    const result = JSON.parse(screen.getByTestId('result').textContent ?? '{}')
    expect(result.status).toBe('error')
    expect(readDaemonTokenOnce()).toBeNull()
    expect(window.location.hash).not.toContain('wb=')
  })

  it('returns {status:"error"} for malformed base64', () => {
    setHash('#wb=!!!not-base64!!!')
    render(<Consumer />)
    const result = JSON.parse(screen.getByTestId('result').textContent ?? '{}')
    expect(result.status).toBe('error')
  })

  it('returns {status:"error"} for a schema-invalid payload', () => {
    const json = JSON.stringify({ baseUrl: 'http://127.0.0.1:3000', path: 'no-workspace' })
    const b64 = btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    setHash(`#wb=${b64}`)
    render(<Consumer />)
    const result = JSON.parse(screen.getByTestId('result').textContent ?? '{}')
    expect(result.status).toBe('error')
  })

  it('strips the #wb= fragment even when the payload fails schema validation', () => {
    // Schema-invalid because of the unknown `extra` field (.strict()), but it
    // still carries a bootstrapToken that must not linger in the URL.
    const json = JSON.stringify({
      baseUrl: 'http://127.0.0.1:3000',
      extra: 'unexpected-field',
    })
    const b64 = btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    setHash(`#wb=${b64}`)
    render(<Consumer />)
    const result = JSON.parse(screen.getByTestId('result').textContent ?? '{}')
    expect(result.status).toBe('error')
    expect(window.location.hash).not.toContain('wb=')
    expect(window.location.hash).not.toContain('sekrit-token-leak')
  })

  it('strips the #wb= fragment for malformed base64 too', () => {
    setHash('#wb=!!!not-base64!!!')
    render(<Consumer />)
    const result = JSON.parse(screen.getByTestId('result').textContent ?? '{}')
    expect(result.status).toBe('error')
    expect(window.location.hash).not.toContain('wb=')
  })

  it('never throws, and only consumes the fragment once across StrictMode double-mount', () => {
    setHash(
      encodeDaemonConnectionFragment({
        baseUrl: 'http://127.0.0.1:3000',
      }),
    )
    render(
      <StrictMode>
        <Consumer />
      </StrictMode>,
    )
    const result = JSON.parse(screen.getByTestId('result').textContent ?? '{}')
    expect(result.status).toBe('paired')
    expect(readDaemonTokenOnce()).toBeNull()

    cleanup()
    render(<Consumer />)
    const remounted = JSON.parse(screen.getByTestId('result').textContent ?? '{}')
    // module-level cache: still reports paired even though the fragment
    // (and the browser hash) has already been stripped.
    expect(remounted.status).toBe('paired')
  })
})
