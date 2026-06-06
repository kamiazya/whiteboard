import { test as fcTest } from '@fast-check/vitest'
import * as fc from 'fast-check'

export { fc, fcTest }

// Pin a default seed so property runs are REPRODUCIBLE: without it fast-check picks a
// fresh random seed each run, so a rare counterexample (or a slow case under load) can
// intermittently red the suite with no way to re-run the same inputs. Override with the
// FC_SEED env var to explore other inputs (e.g. `FC_SEED=$RANDOM pnpm test`).
const DEFAULT_FC_SEED = process.env.FC_SEED ? Number(process.env.FC_SEED) : 0x5eed

export function withDefaults(override?: fc.Parameters<never>): fc.Parameters<never> {
  return { numRuns: 200, seed: DEFAULT_FC_SEED, ...override }
}
