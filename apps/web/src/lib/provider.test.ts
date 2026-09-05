// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { EMPTY_RUNTIME_CONFIG } from '../runtime-config.js'
import {
  resolveHostedProviderStateFromRaw,
  resolveProviderState,
  resolveProviderStateFromRaw,
} from './provider.js'

describe('resolveProviderState', () => {
  it('returns "browser" when daemonBaseUrl is absent', () => {
    expect(resolveProviderState(EMPTY_RUNTIME_CONFIG).kind).toBe('browser')
  })

  it('returns "daemon" only when daemonBaseUrl is present', () => {
    expect(resolveProviderState({ daemonBaseUrl: 'http://127.0.0.1:3099' }).kind).toBe('daemon')
  })

  it('"daemon" state carries daemonBaseUrl', () => {
    const state = resolveProviderState({ daemonBaseUrl: 'http://127.0.0.1:3099' })
    expect(state).toMatchObject({ kind: 'daemon', daemonBaseUrl: 'http://127.0.0.1:3099' })
  })

  it('browser capabilities: no merge — and neither versions nor branches is a capability', () => {
    const state = resolveProviderState(EMPTY_RUNTIME_CONFIG)
    expect(state).toMatchObject({ kind: 'browser', capabilities: { merge: false } })
    // A flag both keepers set the same way is not a capability, and each of
    // these left for that reason as the browser keeper grew the feature:
    // `versions` when it kept its own history, `branches` when it kept its
    // own variations on the workspace record.
    expect(state.kind === 'browser' && 'versions' in state.capabilities).toBe(false)
    expect(state.kind === 'browser' && 'branches' in state.capabilities).toBe(false)
  })

  it('daemon capabilities: merge, which is the one thing the keepers still differ on', () => {
    const state = resolveProviderState({ daemonBaseUrl: 'http://127.0.0.1:3099' })
    expect(state).toMatchObject({ kind: 'daemon', capabilities: { merge: true } })
    expect(state.kind === 'daemon' && 'branches' in state.capabilities).toBe(false)
  })

  it('descriptor JSON contains no token Authorization Bearer secret fields', () => {
    const daemonState = resolveProviderState({ daemonBaseUrl: 'http://127.0.0.1:3099' })
    const localState = resolveProviderState(EMPTY_RUNTIME_CONFIG)
    for (const state of [daemonState, localState]) {
      const serialized = JSON.stringify(state)
      expect(serialized).not.toMatch(/\btoken\b|\bAuthorization\b|\bBearer\b|\bsecret\b/i)
    }
  })
})

describe('resolveProviderStateFromRaw', () => {
  it('empty object returns "browser" state', () => {
    expect(resolveProviderStateFromRaw({}).kind).toBe('browser')
  })

  it('valid daemonBaseUrl returns "daemon" state', () => {
    expect(resolveProviderStateFromRaw({ daemonBaseUrl: 'http://127.0.0.1:3099' }).kind).toBe(
      'daemon',
    )
  })

  it('invalid URL returns invalid-config state', () => {
    expect(resolveProviderStateFromRaw({ daemonBaseUrl: 'not-a-url' }).kind).toBe('invalid-config')
  })

  it('invalid config message does not expose raw credentials or query parameters', () => {
    const state = resolveProviderStateFromRaw({
      daemonBaseUrl: 'https://user:secretpass@example.com?token=abc123',
    })
    expect(state.kind).toBe('invalid-config')
    if (state.kind === 'invalid-config') {
      expect(state.message).not.toContain('secretpass')
      expect(state.message).not.toContain('token=abc123')
      expect(state.message).not.toContain('user:')
    }
  })

  it('invalid config message does not expose path component', () => {
    const state = resolveProviderStateFromRaw({ daemonBaseUrl: 'https://example.com/secret-path' })
    expect(state.kind).toBe('invalid-config')
    if (state.kind === 'invalid-config') {
      expect(state.message).not.toContain('/secret-path')
    }
  })

  it('credential-bearing config with unknown keys becomes invalid-config (fail-closed)', () => {
    const state = resolveProviderStateFromRaw({
      daemonBaseUrl: 'http://127.0.0.1:3099',
      token: 'secret-value',
    })
    expect(state.kind).toBe('invalid-config')
  })

  it('credential-bearing config message does not expose the token value', () => {
    const state = resolveProviderStateFromRaw({ token: 'my-bearer-token' })
    expect(state.kind).toBe('invalid-config')
    if (state.kind === 'invalid-config') {
      expect(state.message).not.toContain('my-bearer-token')
    }
  })
})

describe('resolveHostedProviderStateFromRaw', () => {
  it('empty object returns "browser" state', () => {
    expect(resolveHostedProviderStateFromRaw({}).kind).toBe('browser')
  })

  it('production publicOrigin with no daemon returns "browser"', () => {
    const state = resolveHostedProviderStateFromRaw({
      publicOrigin: 'https://kamiazya-whiteboard.pages.dev',
    })
    expect(state.kind).toBe('browser')
  })

  it('preview publicOrigin returns invalid-config', () => {
    const state = resolveHostedProviderStateFromRaw({
      publicOrigin: 'https://abc123.kamiazya-whiteboard.pages.dev',
    })
    expect(state.kind).toBe('invalid-config')
  })

  it('localhost publicOrigin returns invalid-config', () => {
    const state = resolveHostedProviderStateFromRaw({ publicOrigin: 'https://localhost:5173' })
    expect(state.kind).toBe('invalid-config')
  })

  it('invalid-config message does not expose the rejected publicOrigin value', () => {
    const state = resolveHostedProviderStateFromRaw({
      publicOrigin: 'https://secret.kamiazya-whiteboard.pages.dev',
    })
    expect(state.kind).toBe('invalid-config')
    if (state.kind === 'invalid-config') {
      expect(state.message).not.toContain('secret')
      expect(state.message).not.toMatch(/https?:\/\//)
    }
  })

  // browserOrigin policy: preview deploys (latest.<project>.pages.dev, per-PR
  // branch aliases, hash previews) run in browser mode — offline and
  // origin-agnostic — but must never connect to a daemon from a preview origin.
  it('preview browserOrigin with empty runtime config returns "browser"', () => {
    const state = resolveHostedProviderStateFromRaw(
      {},
      'https://abc123.kamiazya-whiteboard.pages.dev',
    )
    expect(state.kind).toBe('browser')
  })

  it('latest-alias browserOrigin with empty runtime config returns "browser"', () => {
    const state = resolveHostedProviderStateFromRaw(
      {},
      'https://latest.kamiazya-whiteboard.pages.dev',
    )
    expect(state.kind).toBe('browser')
  })

  it('preview browserOrigin with a daemonBaseUrl config returns invalid-config (daemon refused on previews)', () => {
    const state = resolveHostedProviderStateFromRaw(
      { daemonBaseUrl: 'http://127.0.0.1:3099' },
      'https://abc123.kamiazya-whiteboard.pages.dev',
    )
    expect(state.kind).toBe('invalid-config')
  })

  it('production browserOrigin with empty runtime config returns "browser"', () => {
    const state = resolveHostedProviderStateFromRaw({}, 'https://kamiazya-whiteboard.pages.dev')
    expect(state.kind).toBe('browser')
  })

  it('localhost browserOrigin with empty runtime config returns "browser" (local dev)', () => {
    const state = resolveHostedProviderStateFromRaw({}, 'https://localhost:5173')
    expect(state.kind).toBe('browser')
  })

  it('custom domain publicOrigin surfaces the specific unsupported-custom-domain copy (no browserOrigin)', () => {
    const state = resolveHostedProviderStateFromRaw({
      publicOrigin: 'https://custom.example.com',
    })
    expect(state.kind).toBe('invalid-config')
    if (state.kind === 'invalid-config') {
      expect(state.message).toMatch(/custom domain/i)
      expect(state.message).not.toBe('Runtime configuration is invalid.')
    }
  })

  it('custom domain publicOrigin surfaces the specific copy on the preview-browserOrigin branch too', () => {
    const state = resolveHostedProviderStateFromRaw(
      { publicOrigin: 'https://custom.example.com' },
      'https://abc123.kamiazya-whiteboard.pages.dev',
    )
    expect(state.kind).toBe('invalid-config')
    if (state.kind === 'invalid-config') {
      expect(state.message).toMatch(/custom domain/i)
      expect(state.message).not.toBe('Runtime configuration is invalid.')
    }
  })

  it('Zod-invalid publicOrigin still yields the generic invalid-config message (no policy-error reflection)', () => {
    const state = resolveHostedProviderStateFromRaw({ publicOrigin: 'not-a-url' })
    expect(state.kind).toBe('invalid-config')
    if (state.kind === 'invalid-config') {
      expect(state.message).toBe('Runtime configuration is invalid.')
    }
  })

  it('daemon refusal on a preview browserOrigin does not expose the origin value', () => {
    const state = resolveHostedProviderStateFromRaw(
      { daemonBaseUrl: 'http://127.0.0.1:3099' },
      'https://secret-hash.kamiazya-whiteboard.pages.dev',
    )
    expect(state.kind).toBe('invalid-config')
    if (state.kind === 'invalid-config') {
      expect(state.message).not.toContain('secret-hash')
      expect(state.message).not.toMatch(/https?:\/\//)
    }
  })
})
