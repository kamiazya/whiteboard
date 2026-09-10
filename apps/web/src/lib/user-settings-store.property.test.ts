/**
 * The settings schema is `.strict()` at every level and the loader falls
 * back to defaults on ANY parse failure, so a migration that emits one key
 * the live schema does not admit discards the user's whole payload —
 * daemon URL, known daemons, theme — and nothing reports it. The migration
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
  legacyV1SettingsSchema,
  legacyV2SettingsSchema,
  migrateV1,
  migrateV2,
  userSettingsSchema,
} from './user-settings-store.js'

/** A random string is never an http(s) URL, so the URL fields draw from real ones. */
const override = (path: string, _schema: z.ZodTypeAny): fc.Arbitrary<unknown> | undefined =>
  /BaseUrl/.test(path)
    ? fc.constantFrom('http://127.0.0.1:3099', 'https://daemon.example', 'http://localhost:3292')
    : undefined

/** Modulo JSON's own identities (`-0` is stored as `0`): what `localStorage` can hand back. */
const viaJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value))

const v1Arb = arbitraryForSchema(legacyV1SettingsSchema, { override })
const v2Arb = arbitraryForSchema(legacyV2SettingsSchema, { override })
const liveArb = arbitraryForSchema(userSettingsSchema, { override })

describe('user settings migrations are total over what their source schemas admit', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  fcTest.prop([v1Arb], withDefaults())(
    'a v1 payload migrates to a live one and keeps what it said',
    (v1) => {
      const live = userSettingsSchema.parse(migrateV2(migrateV1(v1)))
      expect(live.storage.daemonBaseUrl).toEqual(v1.storage.localDaemonBaseUrl)
      expect(live.storage.knownDaemonBaseUrls).toEqual(v1.storage.knownDaemonBaseUrls)
      expect(live.storage.dismissedDaemonBaseUrls).toEqual(v1.storage.dismissedDaemonBaseUrls)
      expect(live.storage.lastConnectedWorkspaceId).toEqual(v1.storage.lastConnectedWorkspaceId)
      expect(live.appearance).toEqual(v1.appearance)
      expect(live.capabilities.webMcpEnabled).toEqual(v1.capabilities.webMcpEnabled)
      expect(live.migration.promotion?.ok).toEqual(v1.migration.promotion?.ok)
      expect(live.migration.promotion?.workspaceId).toEqual(v1.migration.promotion?.workspaceId)
    },
  )

  fcTest.prop([v2Arb], withDefaults())(
    'a v2 payload migrates to a live one and keeps its replicas',
    (v2) => {
      const live = userSettingsSchema.parse(migrateV2(v2))
      expect(live.storage).toEqual(v2.storage)
      expect(live.appearance).toEqual(v2.appearance)
      expect(live.migration.promotion?.ok).toEqual(v2.migration.promotion?.ok)
    },
  )

  fcTest.prop([v1Arb], withDefaults({ numRuns: 60 }))(
    'the store reads a stored v1 payload as its migration, never as defaults',
    (v1) => {
      localStorage.setItem(LEGACY_V1_STORAGE_KEY, JSON.stringify(v1))
      expect(createUserSettingsStore().load()).toEqual(viaJson(migrateV2(migrateV1(v1))))
    },
  )

  fcTest.prop([v2Arb], withDefaults({ numRuns: 60 }))(
    'the store reads a stored v2 payload as its migration, never as defaults',
    (v2) => {
      localStorage.setItem(LEGACY_V2_STORAGE_KEY, JSON.stringify(v2))
      expect(createUserSettingsStore().load()).toEqual(viaJson(migrateV2(v2)))
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
