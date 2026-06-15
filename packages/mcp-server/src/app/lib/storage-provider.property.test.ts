// Property catalog: P-PROV-001 (explicit provider intent is stronger
// than UserSettings markers) and P-PROV-002 (explicit local-daemon mode
// must not silently fallback to browser-local).
//
// These properties extend PBT coverage to the tokenless-daemon case:
// a null token in the runtime config must not be conflated with an
// absent config, and URL-mode precedence must hold for any token value.

import { describe, expect } from 'vitest'
import { resolveBrowserLocalRedirect } from './browser-local-bootstrap.js'
import { fc, fcTest, withDefaults } from '../../shared/test-utils/fast-check.js'
import { type DaemonRuntimeConfig, resolveStorageProvider } from './storage-provider.js'
import { defaultUserSettings } from './user-settings-store.js'

// Narrow domain: daemon tokens are either null (tokenless/dev mode) or
// a non-empty printable string. The resolver must treat both as valid
// "daemon is serving this page" signals.
const tokenArb: fc.Arbitrary<string | null> = fc.oneof(
  fc.constant(null),
  fc.string({ minLength: 1, maxLength: 64 }),
)

// Representative loopback origins matching the addresses the daemon
// auth-binding permits. The property must hold for IPv4, hostname, and
// IPv6-bracket forms.
const loopbackOriginArb = fc.constantFrom(
  'http://127.0.0.1:3099',
  'http://localhost:3099',
  'http://[::1]:3099',
)

const daemonConfigArb: fc.Arbitrary<DaemonRuntimeConfig> = fc.record({
  baseUrl: loopbackOriginArb,
  token: tokenArb,
})

// Hash / search values that do NOT request browser-local mode, so the
// daemon runtime config is the deciding signal.
const nonBrowserLocalHashArb = fc.constantFrom(
  '',
  '#mode=local-daemon',
  '#theme=dark',
  '#mode=cloud',
)

describe('resolveStorageProvider properties', () => {
  fcTest.prop(
    { cfg: daemonConfigArb },
    withDefaults({ numRuns: 50 }),
  )(
    'daemon config present with any token → local-daemon (no URL override)',
    ({ cfg }) => {
      const result = resolveStorageProvider({
        locationHash: '',
        locationSearch: '',
        daemonRuntimeConfig: cfg,
        settings: defaultUserSettings(),
      })
      expect(result.kind).toBe('local-daemon')
      if (result.kind === 'local-daemon') {
        expect(result.token).toBe(cfg.token)
        expect(result.baseUrl).toBe(cfg.baseUrl)
        expect(result.source).toBe('runtime-config')
      }
    },
  )

  fcTest.prop(
    { baseUrl: loopbackOriginArb },
    withDefaults({ numRuns: 20 }),
  )(
    'tokenless config (token: null) resolves to local-daemon, not the same as absent config',
    ({ baseUrl }) => {
      const withNullToken = resolveStorageProvider({
        locationHash: '',
        locationSearch: '',
        daemonRuntimeConfig: { baseUrl, token: null },
        settings: defaultUserSettings(),
      })
      const withAbsentConfig = resolveStorageProvider({
        locationHash: '',
        locationSearch: '',
        daemonRuntimeConfig: null,
        settings: defaultUserSettings(),
      })
      expect(withNullToken.kind).toBe('local-daemon')
      expect(withAbsentConfig.kind).not.toBe('local-daemon')
    },
  )

  fcTest.prop(
    { cfg: daemonConfigArb },
    withDefaults({ numRuns: 40 }),
  )(
    'explicit mode=browser-local URL overrides daemon config with any token',
    ({ cfg }) => {
      for (const [hash, search] of [
        ['#mode=browser-local', ''],
        ['', '?mode=browser-local'],
      ] as Array<[string, string]>) {
        const result = resolveStorageProvider({
          locationHash: hash,
          locationSearch: search,
          daemonRuntimeConfig: cfg,
          settings: defaultUserSettings(),
        })
        expect(result.kind).toBe('browser-local')
        if (result.kind === 'browser-local') {
          expect(result.source).toBe('url')
        }
      }
    },
  )

  fcTest.prop(
    { cfg: daemonConfigArb },
    withDefaults({ numRuns: 40 }),
  )(
    'explicit mode=local-daemon URL with config (any token) → local-daemon from url',
    ({ cfg }) => {
      for (const [hash, search] of [
        ['#mode=local-daemon', ''],
        ['', '?mode=local-daemon'],
      ] as Array<[string, string]>) {
        const result = resolveStorageProvider({
          locationHash: hash,
          locationSearch: search,
          daemonRuntimeConfig: cfg,
          settings: defaultUserSettings(),
        })
        expect(result.kind).toBe('local-daemon')
        if (result.kind === 'local-daemon') {
          expect(result.source).toBe('url')
          expect(result.token).toBe(cfg.token)
          expect(result.baseUrl).toBe(cfg.baseUrl)
        }
      }
    },
  )

  fcTest.prop(
    { cfg: daemonConfigArb, hash: nonBrowserLocalHashArb },
    withDefaults({ numRuns: 40 }),
  )(
    'non-browser-local URL hash combined with daemon config never resolves to browser-local',
    ({ cfg, hash }) => {
      const result = resolveStorageProvider({
        locationHash: hash,
        locationSearch: '',
        daemonRuntimeConfig: cfg,
        settings: defaultUserSettings(),
      })
      expect(result.kind).not.toBe('browser-local')
    },
  )
})

describe('resolveBrowserLocalRedirect properties', () => {
  fcTest.prop(
    { cfg: daemonConfigArb },
    withDefaults({ numRuns: 50 }),
  )(
    'daemon config present (any token) without browser-local URL → no redirect',
    ({ cfg }) => {
      const result = resolveBrowserLocalRedirect({
        locationHash: '',
        locationSearch: '',
        currentPathname: '/',
        daemonRuntimeConfig: cfg,
        settings: defaultUserSettings(),
      })
      expect(result.replacePathname).toBeNull()
    },
  )

  fcTest.prop(
    { baseUrl: loopbackOriginArb },
    withDefaults({ numRuns: 20 }),
  )(
    'tokenless daemon config (token: null) never triggers /browser-local redirect',
    ({ baseUrl }) => {
      const result = resolveBrowserLocalRedirect({
        locationHash: '',
        locationSearch: '',
        currentPathname: '/',
        daemonRuntimeConfig: { baseUrl, token: null },
        settings: defaultUserSettings(),
      })
      expect(result.replacePathname).toBeNull()
    },
  )

  fcTest.prop(
    { cfg: daemonConfigArb, hash: nonBrowserLocalHashArb },
    withDefaults({ numRuns: 40 }),
  )(
    'non-browser-local URL hash combined with daemon config → no redirect',
    ({ cfg, hash }) => {
      const result = resolveBrowserLocalRedirect({
        locationHash: hash,
        locationSearch: '',
        currentPathname: '/',
        daemonRuntimeConfig: cfg,
        settings: defaultUserSettings(),
      })
      expect(result.replacePathname).toBeNull()
    },
  )
})
