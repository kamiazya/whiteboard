import { describe, expect, it } from 'vitest'
import { migrations } from './migrations/index.js'
import { PUBLISHED_MIGRATION_NAMES } from './published-migration-names.js'

// Drift guard for migration names that have shipped in published releases.
//
// kysely's migration log is keyed by name: a database created by a build that
// recorded migration "X" cannot be opened by a build whose provider lacks "X"
// (it throws "corrupted migrations"). So adding or removing a migration name is
// a release-compatibility event, not a routine refactor.
//
// PUBLISHED_MIGRATION_NAMES is the checked-in source of truth. This test fails
// whenever the runtime provider's names diverge from it, forcing the change to
// update the manifest in the SAME commit — which puts the add/removal in the
// diff where a reviewer must see it. Per the disposable-DB policy a removal is
// allowed, but it must be deliberate and documented (manifest update + upgrade
// note), never silent.
describe('published migration names manifest', () => {
  it('matches the runtime migration provider exactly', () => {
    const providerNames = Object.keys(migrations).sort()
    const manifestNames = [...PUBLISHED_MIGRATION_NAMES].sort()

    const addedInCode = providerNames.filter((n) => !manifestNames.includes(n))
    const removedFromCode = manifestNames.filter((n) => !providerNames.includes(n))

    expect(
      addedInCode,
      'New migration(s) are registered but not in PUBLISHED_MIGRATION_NAMES. ' +
        'Add them to published-migration-names.ts in this same commit.',
    ).toEqual([])
    expect(
      removedFromCode,
      'Migration name(s) were removed from the provider but still in ' +
        'PUBLISHED_MIGRATION_NAMES. Removing a published migration breaks DBs ' +
        'that recorded it. If this is deliberate (disposable-DB policy), remove ' +
        'them from the manifest in this same commit AND add an upgrade note.',
    ).toEqual([])
  })
})
