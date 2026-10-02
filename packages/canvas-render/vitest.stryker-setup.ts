import * as fc from 'fast-check'

/**
 * Pins fast-check's seed for the mutation lane only, so a property's title is
 * the same in every process. Stryker re-selects the tests covering a mutant by
 * title, and `@fast-check/vitest` puts the seed in it — see
 * `src/mutation-lane-selection.test.ts`.
 *
 * The cost is that every run of the lane draws the same inputs. That is a fair
 * trade for a lane whose output is a list of survivors to reproduce by hand: a
 * survivor that a different draw would have killed is a finding about the
 * generator, and a fixed draw makes it repeatable. Never use this for a normal
 * run, where the fresh seed is what lets properties keep finding cases.
 */
export const STRYKER_PROPERTY_SEED = 20_260_901

fc.configureGlobal({ seed: STRYKER_PROPERTY_SEED })
