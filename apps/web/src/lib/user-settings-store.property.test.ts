/**
 * The settings schema is `.strict()` at every level and the loader falls
 * back to defaults on ANY parse failure, so a migration that emits one key
 * the live schema does not admit discards the user's whole payload —
 * daemon URL, cached copies, theme — and nothing reports it. The migration
 * chain is therefore total over what its source schemas admit, and what
 * it carries across is checked field by field, not only "it parsed".
 */
import { arbitraryForSchema } from '@kamiazya/whiteboard-model/test-utils'
import { beforeEach, describe, expect } from 'vitest'
import type { z } from 'zod'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check.js'
import {
  createUserSettingsStore,
  LEGACY_V1_STORAGE_KEY,
  LEGACY_V2_STORAGE_KEY,
  LEGACY_V3_STORAGE_KEY,
  LEGACY_V4_STORAGE_KEY,
  legacyV1SettingsSchema,
  legacyV2SettingsSchema,
  legacyV3SettingsSchema,
  legacyV4SettingsSchema,
  migrateV1,
  migrateV2,
  migrateV3,
  migrateV4,
  userSettingsSchema,
} from './user-settings-store.js'

/**
 * A random string is never an http(s) URL, so the URL fields draw from real
 * ones. Only a STRING is overridden: `knownDaemonBaseUrls` matches the path
 * too, and a string drawn for that array is refused by its own schema, so the
 * field was never generated at all and every property here passed over it.
 */
const override = (path: string, schema: z.ZodTypeAny): fc.Arbitrary<unknown> | undefined =>
  /BaseUrl/.test(path) && schema.def.type === 'string'
    ? fc.constantFrom('http://127.0.0.1:3099', 'https://daemon.example', 'http://localhost:3292')
    : undefined

/** Modulo JSON's own identities (`-0` is stored as `0`): what `localStorage` can hand back. */
const viaJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value))

const v1Arb = arbitraryForSchema(legacyV1SettingsSchema, { override })
const v2Arb = arbitraryForSchema(legacyV2SettingsSchema, { override })
const v3Arb = arbitraryForSchema(legacyV3SettingsSchema, { override })
const v4Arb = arbitraryForSchema(legacyV4SettingsSchema, { override })

/** What the v3 -> v4 step drops: the pairing era's storage fields and a move's `attested`. */
const RETIRED_V3_STORAGE = [
  'lastConnectedWorkspaceId',
  'lastConnectedPath',
  'knownDaemonBaseUrls',
  'dismissedDaemonBaseUrls',
  'dismissedDaemonCtaAt',
  'dismissedDaemonCtaInstanceId',
] as const
/** What the v4 -> v5 step drops: the two dismissal stamps nothing reads. */
const RETIRED_V4_STORAGE = ['dismissedPersistenceWarningAt', 'dismissedBetaBannerAt'] as const
const liveArb = arbitraryForSchema(userSettingsSchema, { override })

/** Every step from a v3 payload to the live shape. */
const fromV3 = (v3: z.infer<typeof legacyV3SettingsSchema>) => migrateV4(migrateV3(v3))

describe('user settings migrations are total over what their source schemas admit', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  fcTest.prop([v1Arb], withDefaults())(
    'a v1 payload migrates to a live one and keeps what it said',
    (v1) => {
      const live = userSettingsSchema.parse(fromV3(migrateV2(migrateV1(v1))))
      expect(live.storage.daemonBaseUrl).toEqual(v1.storage.localDaemonBaseUrl)
      for (const key of RETIRED_V4_STORAGE) expect(live.storage).not.toHaveProperty(key)
      expect(live.appearance).toEqual(v1.appearance)
      expect(live.capabilities.webMcpEnabled).toEqual(v1.capabilities.webMcpEnabled)
      expect(live.migration.promotion?.ok).toEqual(v1.migration.promotion?.ok)
      expect(live.migration.promotion?.workspaceId).toEqual(v1.migration.promotion?.workspaceId)
    },
  )

  fcTest.prop([v2Arb], withDefaults())(
    'a v2 payload migrates to a live one and keeps its replicas',
    (v2) => {
      const live = userSettingsSchema.parse(fromV3(migrateV2(v2)))
      expect(live.storage.replicas).toEqual(v2.storage.replicas)
      expect(live.storage.daemonBaseUrl).toEqual(v2.storage.daemonBaseUrl)
      expect(live.appearance).toEqual(v2.appearance)
      expect(live.migration.promotion?.ok).toEqual(v2.migration.promotion?.ok)
    },
  )

  fcTest.prop([v3Arb], withDefaults())(
    'a v3 payload migrates to a live one, keeping everything but the retired fields',
    (v3) => {
      const live = userSettingsSchema.parse(fromV3(v3))
      const retired: readonly string[] = [...RETIRED_V3_STORAGE, ...RETIRED_V4_STORAGE]
      const kept = Object.fromEntries(
        Object.entries(v3.storage).filter(([key]) => !retired.includes(key)),
      )
      expect(live.storage).toEqual(kept)
      for (const key of retired) expect(live.storage).not.toHaveProperty(key)
      const { attested: _attested, ...promotion } = (v3.migration.promotion ?? {}) as {
        attested?: boolean
      }
      expect(live.migration.promotion ?? {}).toEqual(promotion)
      expect(live.capabilities).toEqual(v3.capabilities)
      expect(live.appearance).toEqual(v3.appearance)
    },
  )

  fcTest.prop([v4Arb], withDefaults())(
    'a v4 payload migrates to a live one, keeping everything but the two stamps',
    (v4) => {
      const live = userSettingsSchema.parse(migrateV4(v4))
      const kept = Object.fromEntries(
        Object.entries(v4.storage).filter(
          ([key]) => !(RETIRED_V4_STORAGE as readonly string[]).includes(key),
        ),
      )
      expect(live.storage).toEqual(kept)
      for (const key of RETIRED_V4_STORAGE) expect(live.storage).not.toHaveProperty(key)
      expect(live.migration).toEqual(v4.migration)
      expect(live.capabilities).toEqual(v4.capabilities)
      expect(live.appearance).toEqual(v4.appearance)
    },
  )

  fcTest.prop([v1Arb], withDefaults({ numRuns: 60 }))(
    'the store reads a stored v1 payload as its migration, never as defaults',
    (v1) => {
      localStorage.setItem(LEGACY_V1_STORAGE_KEY, JSON.stringify(v1))
      expect(createUserSettingsStore().load()).toEqual(viaJson(fromV3(migrateV2(migrateV1(v1)))))
    },
  )

  fcTest.prop([v2Arb], withDefaults({ numRuns: 60 }))(
    'the store reads a stored v2 payload as its migration, never as defaults',
    (v2) => {
      localStorage.setItem(LEGACY_V2_STORAGE_KEY, JSON.stringify(v2))
      expect(createUserSettingsStore().load()).toEqual(viaJson(fromV3(migrateV2(v2))))
    },
  )

  fcTest.prop([v3Arb], withDefaults({ numRuns: 60 }))(
    'the store reads a stored v3 payload as its migration, never as defaults',
    (v3) => {
      localStorage.setItem(LEGACY_V3_STORAGE_KEY, JSON.stringify(v3))
      expect(createUserSettingsStore().load()).toEqual(viaJson(fromV3(v3)))
    },
  )

  fcTest.prop([v4Arb], withDefaults({ numRuns: 60 }))(
    'the store reads a stored v4 payload as its migration, never as defaults',
    (v4) => {
      localStorage.setItem(LEGACY_V4_STORAGE_KEY, JSON.stringify(v4))
      expect(createUserSettingsStore().load()).toEqual(viaJson(migrateV4(v4)))
    },
  )

  fcTest.prop([liveArb], withDefaults({ numRuns: 60 }))(
    'save then load returns what was saved',
    (settings) => {
      createUserSettingsStore().save(settings)
      expect(createUserSettingsStore().load()).toEqual(viaJson(settings))
    },
  )
})
