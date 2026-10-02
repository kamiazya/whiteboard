// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { RuntimeConfig } from '../runtime-config.js'
import { resolveHostedProviderStateFromRaw, resolveProviderState } from './provider.js'

const EMPTY_RUNTIME_CONFIG: RuntimeConfig = {}

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

  it('resolves to the browser keeper, carrying nothing but which keeper it is', () => {
    const state = resolveProviderState(EMPTY_RUNTIME_CONFIG)
    expect(state).toEqual({ kind: 'browser' })
  })

  it('resolves to the daemon keeper, carrying its base URL and nothing else', () => {
    const state = resolveProviderState({ daemonBaseUrl: 'http://127.0.0.1:3099' })
    expect(state).toEqual({ kind: 'daemon', daemonBaseUrl: 'http://127.0.0.1:3099' })
  })

  // `toEqual` above rather than `toMatchObject`, deliberately: the assertion
  // this pair replaces is what a `capabilities` map would fail. Four flags
  // lived there and left one at a time as the browser keeper grew each
  // feature — `workspaces`, `versions`, `branches`, `merge` — each because a
  // flag both keepers set the same way declares no difference. An exact
  // equality is what stops a fifth arriving without that argument being made
  // again.

  it('descriptor JSON contains no token Authorization Bearer secret fields', () => {
    const daemonState = resolveProviderState({ daemonBaseUrl: 'http://127.0.0.1:3099' })
    const localState = resolveProviderState(EMPTY_RUNTIME_CONFIG)
    for (const state of [daemonState, localState]) {
      const serialized = JSON.stringify(state)
      expect(serialized).not.toMatch(/\btoken\b|\bAuthorization\b|\bBearer\b|\bsecret\b/i)
    }
  })
})

describe('resolveHostedProviderStateFromRaw', () => {
  it('valid daemonBaseUrl returns "daemon" state', () => {
    expect(resolveHostedProviderStateFromRaw({ daemonBaseUrl: 'http://127.0.0.1:3099' }).kind).toBe(
      'daemon',
    )
  })

  it('invalid URL returns invalid-config state', () => {
    expect(resolveHostedProviderStateFromRaw({ daemonBaseUrl: 'not-a-url' }).kind).toBe(
      'invalid-config',
    )
  })

  it('invalid config message does not expose raw credentials or query parameters', () => {
    const state = resolveHostedProviderStateFromRaw({
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
    const state = resolveHostedProviderStateFromRaw({
      daemonBaseUrl: 'https://example.com/secret-path',
    })
    expect(state.kind).toBe('invalid-config')
    if (state.kind === 'invalid-config') {
      expect(state.message).not.toContain('/secret-path')
    }
  })

  it('credential-bearing config with unknown keys becomes invalid-config (fail-closed)', () => {
    const state = resolveHostedProviderStateFromRaw({
      daemonBaseUrl: 'http://127.0.0.1:3099',
      token: 'secret-value',
    })
    expect(state.kind).toBe('invalid-config')
  })

  it('credential-bearing config message does not expose the token value', () => {
    const state = resolveHostedProviderStateFromRaw({ token: 'my-bearer-token' })
    expect(state.kind).toBe('invalid-config')
    if (state.kind === 'invalid-config') {
      expect(state.message).not.toContain('my-bearer-token')
    }
  })

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

  it('a browserOrigin that merely ends in the pages domain is not a preview, so a daemon config is kept', () => {
    const state = resolveHostedProviderStateFromRaw(
      { daemonBaseUrl: 'http://127.0.0.1:3099' },
      'https://notkamiazya-whiteboard.pages.dev',
    )
    expect(state.kind).toBe('daemon')
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
