import { describe, expect, it } from 'vitest'
import { EMPTY_RUNTIME_CONFIG } from '../runtime-config.js'
import { resolveHostedProviderStateFromRaw, resolveProviderState, resolveProviderStateFromRaw } from './provider.js'

describe('resolveProviderState', () => {
  it('returns browser-local when daemonBaseUrl is absent', () => {
    expect(resolveProviderState(EMPTY_RUNTIME_CONFIG).kind).toBe('browser-local')
  })

  it('returns local-daemon only when daemonBaseUrl is present', () => {
    expect(resolveProviderState({ daemonBaseUrl: 'http://127.0.0.1:3099' }).kind).toBe('local-daemon')
  })

  it('local-daemon state carries daemonBaseUrl', () => {
    const state = resolveProviderState({ daemonBaseUrl: 'http://127.0.0.1:3099' })
    expect(state).toMatchObject({ kind: 'local-daemon', daemonBaseUrl: 'http://127.0.0.1:3099' })
  })

  it('browser-local capabilities: canvasReadWrite and migrationExport are true', () => {
    const state = resolveProviderState(EMPTY_RUNTIME_CONFIG)
    expect(state).toMatchObject({
      kind: 'browser-local',
      capabilities: { canvasReadWrite: true, migrationExport: true },
    })
  })

  it('browser-local capabilities: migrationImport workspaces versions are false', () => {
    const state = resolveProviderState(EMPTY_RUNTIME_CONFIG)
    expect(state).toMatchObject({
      kind: 'browser-local',
      capabilities: { migrationImport: false, workspaces: false, versions: false },
    })
  })

  it('local-daemon capabilities: workspaces versions migrationImport are true', () => {
    const state = resolveProviderState({ daemonBaseUrl: 'http://127.0.0.1:3099' })
    expect(state).toMatchObject({
      kind: 'local-daemon',
      capabilities: { workspaces: true, versions: true, migrationImport: true },
    })
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
  it('empty object returns browser-local state', () => {
    expect(resolveProviderStateFromRaw({}).kind).toBe('browser-local')
  })

  it('valid daemonBaseUrl returns local-daemon state', () => {
    expect(resolveProviderStateFromRaw({ daemonBaseUrl: 'http://127.0.0.1:3099' }).kind).toBe('local-daemon')
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
  it('empty object returns browser-local state', () => {
    expect(resolveHostedProviderStateFromRaw({}).kind).toBe('browser-local')
  })

  it('production publicOrigin with no daemon returns browser-local', () => {
    const state = resolveHostedProviderStateFromRaw({ publicOrigin: 'https://whiteboard.pages.dev' })
    expect(state.kind).toBe('browser-local')
  })

  it('preview publicOrigin returns invalid-config', () => {
    const state = resolveHostedProviderStateFromRaw({ publicOrigin: 'https://abc123.whiteboard.pages.dev' })
    expect(state.kind).toBe('invalid-config')
  })

  it('localhost publicOrigin returns invalid-config', () => {
    const state = resolveHostedProviderStateFromRaw({ publicOrigin: 'https://localhost:5173' })
    expect(state.kind).toBe('invalid-config')
  })

  it('invalid-config message does not expose the rejected publicOrigin value', () => {
    const state = resolveHostedProviderStateFromRaw({
      publicOrigin: 'https://secret.whiteboard.pages.dev',
    })
    expect(state.kind).toBe('invalid-config')
    if (state.kind === 'invalid-config') {
      expect(state.message).not.toContain('secret')
      expect(state.message).not.toMatch(/https?:\/\//)
    }
  })

  // browserOrigin guard: preview browser origin is rejected even with no runtime config,
  // so a Cloudflare Pages preview deploy cannot silently enter browser-local mode.
  it('preview browserOrigin returns invalid-config even with empty runtime config', () => {
    const state = resolveHostedProviderStateFromRaw({}, 'https://abc123.whiteboard.pages.dev')
    expect(state.kind).toBe('invalid-config')
  })

  it('production browserOrigin with empty runtime config returns browser-local', () => {
    const state = resolveHostedProviderStateFromRaw({}, 'https://whiteboard.pages.dev')
    expect(state.kind).toBe('browser-local')
  })

  it('localhost browserOrigin with empty runtime config returns browser-local (local dev)', () => {
    const state = resolveHostedProviderStateFromRaw({}, 'https://localhost:5173')
    expect(state.kind).toBe('browser-local')
  })

  it('invalid-config from preview browserOrigin does not expose the origin value', () => {
    const state = resolveHostedProviderStateFromRaw({}, 'https://secret-hash.whiteboard.pages.dev')
    expect(state.kind).toBe('invalid-config')
    if (state.kind === 'invalid-config') {
      expect(state.message).not.toContain('secret-hash')
      expect(state.message).not.toMatch(/https?:\/\//)
    }
  })
})
