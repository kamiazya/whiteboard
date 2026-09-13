// @vitest-environment node
/**
 * Every module that reads an IndexedDB object store back through a Zod
 * schema, classified against what round-trips it.
 *
 * `idb-stored-shapes.property.browser.test.tsx` writes through each
 * production writer and reads back through its reader, and it found a real
 * defect the day it was written — a blob whose content type was empty was
 * stored, reported present, and read back as nothing. What it cannot do is
 * notice a store added after it: its subjects are the imports at the top of
 * that file, so a sixth writer/reader pair joins the app and the lane keeps
 * reporting the same passing count over a surface that grew. That is the
 * failure `.claude/rules/coverage-ledger.md` exists for, and the twin of
 * `packages/mcp-server/src/server/persisted-json-surface.test.ts`, which
 * asks the same question of the daemon's files.
 *
 * The probe is a module that names an object store AND hands a record to a
 * schema. Both halves are needed: the store constants alone catch writers
 * that never validate (`loro-store.ts` chunks bytes and parses nothing),
 * and a schema parse alone catches every network client in `lib/`.
 *
 * Source comes from `?raw`, not `node:fs`: apps/web is browser-only and
 * `web-app-boundary.test.ts` enforces it — the same reason
 * `editor-state-surface.test.ts` reads its subject that way.
 */
import { describe, expect, it } from 'vitest'
import { assertScannedLedger } from '../test-utils/coverage-ledger.js'

const sources = import.meta.glob('./*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

/** The lane itself, globbed by name because it is `.tsx` and the scan above is not. */
const laneSources = import.meta.glob('./idb-stored-shapes.property.browser.test.tsx', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

/** What round-trips a stored record, or why nothing does. */
type StoredShapeCoverage =
  /**
   * `idb-stored-shapes.property.browser.test.tsx` writes it and reads it
   * back, under the `describe` this names.
   *
   * The TITLE rather than the module, because "the lane imports this file"
   * is satisfied by an incidental import: the lane imports both modules
   * below as FIXTURES — `browser-idb.ts` for a store name, and
   * `browser-workspace-id.ts` for the id its version case seeds — so an
   * import-shaped check could not fail for either, which reads exactly like
   * a check that held. Naming what a reader can go and look at is the
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
 * checked, silently. This file's twin in mcp-server had the same hole and no
 * typecheck could see it: that package's tsconfig excludes test files.
 */
const notModelled = (reason: string): StoredShapeCoverage => `not modelled: ${reason}`

/**
 * Keyed by module name under `lib/`. Both directions are checked below: a
 * module the scan no longer finds fails as stale, and one it finds that is
 * missing here fails as unclassified.
 */
const STORED_SHAPE_COVERAGE: Record<string, StoredShapeCoverage> = {
  'idb-blob-store.ts': 'round-tripped: IdbBlobStore',
  'document-file-store.ts': 'round-tripped: DocumentFileStore',
  'idb-document-index.ts': 'round-tripped: IdbDocumentIndex',
  'idb-document-store.ts': 'round-tripped: IdbDocumentStore',
  'browser-version-store.ts': 'round-tripped: BrowserVersionStore',

  // The entry follows the migrations rather than the filename: `browser-idb.ts`
  // kept the opener and stopped parsing anything, so the scan no longer sees
  // it at all and an entry left there would be stale.
  'browser-idb-upgrades.ts': notModelled(
    'it holds the upgrade steps, so what matters is what a walk does with a record it CANNOT ' +
      'parse — carried verbatim rather than dropped, which a round trip of parseable records ' +
      'would never exercise. browser-idb-migration.browser.test.tsx drives the upgrades against ' +
      'seeded old-version databases',
  ),
  'browser-workspace-id.ts': notModelled(
    'it validates the workspace id on a row the index already round-trips, and refuses a record ' +
      'not keyed by a canonical id rather than reading a shape of its own. ' +
      'browser-workspace-id.test.ts covers the choice and that refusal',
  ),
}

/** How every object store in this app is named at a call site (`browser-idb.ts` exports them). */
const STORE_CONSTANT = /\b[A-Z][A-Z_]*_STORE\b/
/** `<name>Schema.parse(` / `<name>Schema.safeParse(` — how every schema here is spelled. */
const SCHEMA_PARSE = /[A-Za-z]+Schema\.(?:safeParse|parse)\(/

/**
 * Prose is not a call site. Measured a no-op today — no module merely
 * DESCRIBES a store it does not touch — and kept because the failure mode
 * it prevents is the one that hollows a ledger out: demanding an entry for
 * a module that only mentions the subject teaches people to write an entry
 * to quiet the scan.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

function scanStoredShapeModules(): string[] {
  return Object.entries(sources)
    .filter(([path]) => !path.includes('.test.'))
    .filter(([, source]) => {
      const body = withoutComments(source)
      return STORE_CONSTANT.test(body) && SCHEMA_PARSE.test(body)
    })
    .map(([path]) => path.replace('./', ''))
    .sort()
}

describe('the IndexedDB stored-shape surface', () => {
  it('reads the lib source and finds the modules it is meant to classify', () => {
    expect(Object.keys(sources).length, 'the ?raw glob matched nothing').toBeGreaterThan(30)
    // A probe that stopped matching would report every entry below as stale,
    // which sends the reader to the wrong file entirely. 7 when written.
    expect(
      scanStoredShapeModules().length,
      'the store-constant + schema scan found almost nothing; check both probes against how stores and schemas are spelled now',
    ).toBeGreaterThan(4)
  })

  it('classifies every module that reads a stored record through a schema', () => {
    assertScannedLedger(scanStoredShapeModules(), STORED_SHAPE_COVERAGE, {
      unclassified:
        'a new IndexedDB stored shape is unclassified — add it to STORED_SHAPE_COVERAGE as "round-tripped" (and give it a describe in idb-stored-shapes.property.browser.test.tsx) or as "not modelled: <reason>" naming what covers it instead',
      stale:
        'STORED_SHAPE_COVERAGE names a module that no longer reads a stored record through a schema — drop the entry',
    })
  })

  it('pins every round-tripped shape to a describe the property lane still declares', () => {
    const lane = Object.values(laneSources)[0]
    expect(lane, 'the property lane is not in the glob; check its filename').toBeTypeOf('string')
    const missing = Object.entries(STORED_SHAPE_COVERAGE)
      .flatMap(([name, coverage]) => {
        const title = coverage.startsWith('round-tripped: ') ? coverage.slice(15) : undefined
        return title === undefined ? [] : [{ name, title }]
      })
      .filter(({ title }) => !(lane ?? '').includes(`describe('${title}'`))
    expect(
      missing,
      'a shape is marked round-tripped but idb-stored-shapes.property.browser.test.tsx declares no such describe — cover it there under that title, fix the title here, or say "not modelled: <reason>"',
    ).toEqual([])
  })
})
