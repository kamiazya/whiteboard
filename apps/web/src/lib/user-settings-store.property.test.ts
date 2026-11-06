/**
 * The settings schema is `.strict()` at every level and the loader falls
 * back to defaults on ANY parse failure, so a migration that emits one key
 * the live schema does not admit discards the user's whole payload —
 * daemon URL, cached copies, theme — and nothing reports it. The one
 * remaining migration (v4 -> v5) is therefore total over what its source
 * schema admits, and what it carries across is checked field by field, not
 * only "it parsed".
 */
import { arbitraryForSchema } from '@kamiazya/whiteboard-model/test-utils'
import { beforeEach, describe, expect } from 'vitest'
import type { z } from 'zod'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check.js'
import {
  createUserSettingsStore,
  LEGACY_V4_STORAGE_KEY,
  legacyV4SettingsSchema,
  migrateV4,
  userSettingsSchema,
} from './user-settings-store.js'

/**
 * A random string is never an http(s) URL, so the URL fields draw from real
 * ones. Only a STRING is overridden: a path match alone would also catch an
 * array of URLs, and a string drawn for an array is refused by its own
 * schema, so the field would never be generated and the properties would
 * pass over it.
 */
const override = (path: string, schema: z.ZodTypeAny): fc.Arbitrary<unknown> | undefined =>
  /BaseUrl/.test(path) && schema.def.type === 'string'
    ? fc.constantFrom('http://127.0.0.1:3099', 'https://daemon.example', 'http://localhost:3292')
    : undefined

/** Modulo JSON's own identities (`-0` is stored as `0`): what `localStorage` can hand back. */
const viaJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value))

const v4Arb = arbitraryForSchema(legacyV4SettingsSchema, { override })

/** What the v4 -> v5 step drops: the two dismissal stamps nothing reads. */
const RETIRED_V4_STORAGE = ['dismissedPersistenceWarningAt', 'dismissedBetaBannerAt'] as const
const liveArb = arbitraryForSchema(userSettingsSchema, { override })

describe('the v4 -> v5 migration is total over what its source schema admits', () => {
  beforeEach(() => {
    localStorage.clear()
  })

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
