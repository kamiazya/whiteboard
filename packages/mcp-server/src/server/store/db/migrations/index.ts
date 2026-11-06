import type { Migration } from 'kysely/migration'
import { migration as baseline } from './0001-baseline.js'

// Ordered map; kysely sorts by key so the numeric prefix decides execution
// order. A key is recorded in the database, so published-migration-names.ts
// pins the list, and a name it retired is never reused.
export const migrations: Record<string, Migration> = {
  '0001-baseline': baseline,
}
