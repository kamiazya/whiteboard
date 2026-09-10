/**
 * Every place this package hands a `JSON.parse` result to a Zod schema,
 * classified against what round-trips it.
 *
 * `persisted-json.property.test.ts` is the lane that writes through each
 * production writer and reads back through its reader, and it found a real
 * defect the day it was written. What it could not do is notice a store
 * added after it: its subjects are a list of imports at the top of the
 * file, so a tenth writer/reader pair joins the codebase and the lane keeps
 * reporting the same passing count over a surface that grew. That is the
 * failure `.claude/rules/coverage-ledger.md` exists for, and the route
 * lanes already avoid it — they read `app.routes` and scan the routes
 * directory, so a route without a rule fails the ledger. The store lanes
 * did not, which is what this file fixes.
 *
 * The scan keys on the BOUNDARY rather than on a file's name: a schema
 * being handed `JSON.parse` output is exactly where a writer and a reader
 * can disagree while both typecheck. Not every such place is persistence —
 * a request body and a websocket frame reach a schema the same way — and
 * those are classified too rather than filtered out, because what covers
 * them is a different lane and saying which is the useful part.
 *
 * Two limits, stated rather than found later:
 *
 *   - **A pair split across two files is seen only from its reader.** The
 *     backup result is printed by the CLI and parsed by the scheduler's
 *     subprocess wrapper; the scan finds the parse and nothing points at
 *     the print. A future writer whose reader lives elsewhere is invisible
 *     until someone reads this paragraph.
 *   - **`JSON.parse` is the probe, so a shape read some other way is out of
 *     scope** — `structuredClone` through IndexedDB is the browser's
 *     equivalent and has its own ledger in `apps/web`.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const PACKAGE_SRC = fileURLToPath(new URL('..', import.meta.url))

/** What round-trips a stored shape, or why nothing does. */
type PersistedJsonCoverage =
  /**
   * `persisted-json.property.test.ts` writes it through its writer and reads
   * it back, under the `describe` this names.
   *
   * The TITLE rather than the module, and the check below reads the lane for
   * it, because "the lane imports this file" is satisfied by an incidental
   * import — measured on the browser twin, where the lane imports two
   * not-modelled modules as fixtures and the import-shaped check could not
   * fail for either. Naming what a reader can go and look at is the same
   * mechanism `annotation-surface-parity.test.ts` uses for a pinned cell.
   */
  | `round-tripped: ${string}`
  /** Something else covers it, or a round trip would say nothing. The reason names which. */
  | `not modelled: ${string}`

/**
 * A reason, typed as the ledger's own vocabulary.
 *
 * `'not modelled: ' + reason` widens to `string`, which the record then
 * accepts — so the union that makes an entry state its case stops being
 * checked. Nothing here would notice: this package's tsconfig excludes test
 * files, and the browser twin is where the error surfaced.
 */
const notModelled = (reason: string): PersistedJsonCoverage => `not modelled: ${reason}`

/**
 * Keyed by path under `src/`. An entry is a DECISION about one boundary,
 * and both directions are checked below: a path the scan no longer finds
 * fails as stale, and one it finds that is missing here fails as
 * unclassified. Neither can outlive the other.
 */
const PERSISTED_JSON_COVERAGE: Record<string, PersistedJsonCoverage> = {
  // The daemon's own records, and the stores under them.
  'daemon/daemon-record.ts': 'round-tripped: the daemon record',
  'daemon/daemon-registry.ts': 'round-tripped: the daemon record',
  'server/security/server-mode-record.ts': 'round-tripped: the server-mode record',
  'server/security/pairing-grant-store.ts': 'round-tripped: the pairing grants file',
  'server/store/backup-in-progress.ts': 'round-tripped: the backup-in-progress marker',
  'server/store/backup-blob-mirror.ts': 'round-tripped: the blob manifest',
  'server/store/backup-subprocess.ts': 'round-tripped: the backup result',
  'server/store/db/location-record.ts': 'round-tripped: the database location record',
  'server/store/fs/fs-blob-store.ts': 'round-tripped: the blob envelope',

  'server/security/daemon-identity.ts': notModelled(
    'the written record is a generated Ed25519 keypair, so a property drawing one would draw what ' +
      'the writer already produces and assert that a keypair is a keypair. The restart round trip ' +
      'is an example instead — daemon-identity.test.ts asserts the SAME identity reloads, and that ' +
      'a corrupt or wrong-shape file rotates without echoing the private key',
  ),
  'shared/mkdir-lock.ts': notModelled(
    'the owner file holds a pid and a timestamp this process just wrote, and what matters about it ' +
      'is the reclaim protocol rather than the shape. mkdir-lock.test.ts drives that protocol, ' +
      'including a lock left by a dead holder',
  ),
  'server/release/sbom-artifact-state.ts': notModelled(
    'the sidecar is written by a .mjs release script rather than by this package, and ' +
      'sbom-fingerprint.test.ts already asserts that every sidecar that writer can produce parses ' +
      'through the shared schema — the same round trip, from the writer end',
  ),
  'cli/daemon-support-bundle.ts': notModelled(
    'it re-reads the JSONL that runDaemonLogs just printed, and that shape is round-tripped by ' +
      'shared/diagnostics/log-jsonl.property.test.ts, redaction included',
  ),

  // Not persistence. Classified rather than filtered out, because what
  // covers each is a different lane and naming it is the useful half.
  'server/security/oauth-authz-registry.ts': notModelled(
    'parsed from WHITEBOARD_OAUTH_CLIENT_REGISTRY, which an operator writes and nothing here ' +
      'emits, so there is no writer to round-trip against. Its refusals are ' +
      'oauth-authz-registry.test.ts',
  ),
  'server/routes/ws-validation.ts': notModelled(
    'a frame a CLIENT sends, so this package is the reader alone. The frames the daemon emits are ' +
      "round-tripped by server/routes/ws-emitters.property.test.ts against the browser's own parser",
  ),
  'server/routes/document/restore.ts':
    'not modelled: a request body, fuzzed from its schema by server/app.routes.fuzz.property.test.ts',
  'server/routes/document/versions.ts':
    'not modelled: a request body, fuzzed from its schema by server/app.routes.fuzz.property.test.ts',
  'server/routes/document/export-svg.ts':
    'not modelled: a request body, fuzzed from its schema by server/app.routes.fuzz.property.test.ts',
  'server/routes/export.ts':
    'not modelled: a request body, fuzzed from its schema by server/app.routes.fuzz.property.test.ts',
}

/** `<name>Schema.parse(` / `<name>Schema.safeParse(` — how every schema in this package is spelled. */
const SCHEMA_PARSE = /[A-Za-z]+Schema\.(?:safeParse|parse)\(/

async function scanPersistedJsonFiles(): Promise<string[]> {
  const found: string[] = []
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        // Test helpers are not production readers; a fixture parsing its own
        // JSON is the test, not the boundary.
        if (entry.name !== 'test-utils') await walk(path)
        continue
      }
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue
      const source = await readFile(path, 'utf8')
      if (!source.includes('JSON.parse') || !SCHEMA_PARSE.test(source)) continue
      found.push(path.slice(PACKAGE_SRC.length).replaceAll('\\', '/'))
    }
  }
  await walk(PACKAGE_SRC)
  return found.sort()
}

describe('the persisted-JSON surface', () => {
  it('finds the boundaries it is meant to classify', async () => {
    // A probe that stopped matching would report every entry below as stale,
    // which sends the reader to the wrong file entirely. 19 when written.
    expect(
      (await scanPersistedJsonFiles()).length,
      'the JSON.parse + schema scan found almost nothing; check SCHEMA_PARSE against how schemas are spelled now',
    ).toBeGreaterThan(12)
  })

  it('classifies every place a schema is handed JSON.parse output', async () => {
    const scanned = await scanPersistedJsonFiles()
    const declared = new Set(Object.keys(PERSISTED_JSON_COVERAGE))
    expect(
      scanned.filter((path) => !declared.has(path)),
      'a new stored shape is unclassified — add it to PERSISTED_JSON_COVERAGE as "round-tripped" ' +
        '(and give it a describe in persisted-json.property.test.ts) or as "not modelled: <reason>" ' +
        'naming what covers it instead',
    ).toEqual([])
    expect(
      [...declared].filter((path) => !scanned.includes(path)),
      'PERSISTED_JSON_COVERAGE names a file that no longer hands JSON.parse output to a schema — drop the entry',
    ).toEqual([])
  })

  it('pins every round-tripped shape to a describe the property lane still declares', async () => {
    const lane = await readFile(join(PACKAGE_SRC, 'server/persisted-json.property.test.ts'), 'utf8')
    const missing = Object.entries(PERSISTED_JSON_COVERAGE)
      .flatMap(([path, coverage]) => {
        const title = coverage.startsWith('round-tripped: ') ? coverage.slice(15) : undefined
        return title === undefined ? [] : [{ path, title }]
      })
      .filter(({ title }) => !lane.includes(`describe('${title}'`))
    expect(
      missing,
      'a shape is marked round-tripped but persisted-json.property.test.ts declares no such describe — cover it there under that title, fix the title here, or say "not modelled: <reason>"',
    ).toEqual([])
  })
})
