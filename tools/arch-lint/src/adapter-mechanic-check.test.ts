import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { findAdapterMechanicEdges } from './adapter-mechanic-check.js'
import {
  ADAPTER_HELPER_FILES,
  ADAPTER_SCAN_EXEMPT_FILES,
  ADAPTERS_REACHING_MECHANICS,
  ADAPTERS_REACHING_MECHANICS_CEILING,
  MECHANICS_NOT_SCANNED,
} from './architecture-map.js'
import { collectRelativeImportEdges } from './cycle-check.js'
import { REPO_ROOT, walk } from './scan-roots.js'

const SERVER_DIR = join(REPO_ROOT, 'packages/mcp-server/src/server')

const actual = findAdapterMechanicEdges(
  SERVER_DIR,
  MECHANICS_NOT_SCANNED,
  ADAPTER_SCAN_EXEMPT_FILES,
  ADAPTER_HELPER_FILES,
)

describe('ADR-0018: an adapter may not reach a mechanic directly', () => {
  // A route or an MCP tool registration that imports a mechanic has nowhere
  // to put the operation it is performing except inside itself, so the next
  // surface needing that operation writes it again. Every divergence
  // ADR-0018 records began that way — an agent delete that left thumbnails
  // behind, an agent write that never compacted.
  it('reports no adapter -> mechanic edge outside the allowlist', () => {
    const allowed = new Set(ADAPTERS_REACHING_MECHANICS)
    const unlisted = actual.filter((edge) => !allowed.has(edge))

    expect(
      unlisted,
      'a new adapter reached a mechanic directly. Give the operation a home in ' +
        'server-core (a use case over ports and seams) and call that instead — ' +
        'or, if it is genuinely this deployment telling itself something, name a ' +
        'seam on ServerDeps the way documentTeardown and documentWritten do.',
    ).toEqual([])
  })

  // Guarded from both sides, so an entry cannot outlive its debt. Note this
  // is NOT what keeps the list shrinking — that is the ceiling below, and the
  // comment here claimed otherwise for as long as the claim was false.
  it('every allowlist entry is still a real edge', () => {
    const found = new Set(actual)
    const stale = ADAPTERS_REACHING_MECHANICS.filter((edge) => !found.has(edge))

    expect(
      stale,
      'these edges are gone — delete them from ADAPTERS_REACHING_MECHANICS. ' +
        'An entry that outlives its debt is how an allowlist stops being read.',
    ).toEqual([])
  })

  // The scan reaching nothing would make both assertions above pass while
  // checking nothing at all — the failure mode this repo has been bitten by
  // more than once.
  // The ratchet. The two assertions above stop a fabricated entry and a stale
  // one, and neither has anything to say about the ordinary way this list
  // grows: a real new adapter -> mechanic edge added together with its
  // allowlist line. Measured before this existed — a genuine
  // `routes/export.ts -> backup-in-progress` import, duly listed, passed all
  // six assertions, and the list had gone 35 -> 40 in a week under two
  // comments asserting it could only shrink.
  //
  // Equality rather than an upper bound, so paying debt off is also a failure
  // until the number comes down with it. A ceiling nobody lowers stops
  // recording progress and turns into a budget.
  it('holds the allowlist at its declared ceiling', () => {
    expect(
      ADAPTERS_REACHING_MECHANICS.length,
      ADAPTERS_REACHING_MECHANICS.length > ADAPTERS_REACHING_MECHANICS_CEILING
        ? 'a new adapter -> mechanic edge was added. ADR-0018 is Accepted, so ' +
            'this is debt being taken on against a decision to pay it down: give ' +
            'the operation a home in server-core, or raise the ceiling in the ' +
            'same PR and say there why that was not possible.'
        : 'an edge was paid off — lower ADAPTERS_REACHING_MECHANICS_CEILING to ' +
            'match, so the number keeps recording where the migration is.',
    ).toBe(ADAPTERS_REACHING_MECHANICS_CEILING)
  })

  it('the scan actually reaches the adapter tree', () => {
    expect(actual.length).toBeGreaterThan(10)
  })

  // Asserted against a FIXTURE rather than the real tree, because the real
  // tree is meant to hold no such edge: a guard whose only evidence is a
  // violation that exists today stops proving anything the day it is fixed.
  describe('the matcher sees a mechanic at any depth under store/', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'arch-lint-adapter-'))
    afterAll(() => rmSync(fixture, { recursive: true, force: true }))

    mkdirSync(join(fixture, 'routes'), { recursive: true })
    mkdirSync(join(fixture, 'mcp'), { recursive: true })
    writeFileSync(
      join(fixture, 'routes', 'thing.ts'),
      [
        "import { upsertWorkspaceRow } from '../store/db/upsert-workspace.js'",
        "import { getDocCache } from '../store/doc-cache.js'",
        // Depth is not a property of today's tree: `store/db/` is simply how
        // deep it happens to go. A matcher that hard-codes the depths it has
        // seen is the same blind spot one level down.
        "import { deep } from '../store/db/workspaces/upsert-row.js'",
        'export const thing = [upsertWorkspaceRow, getDocCache, deep]',
      ].join('\n'),
    )
    writeFileSync(join(fixture, 'mcp', 'noop.ts'), 'export const noop = 1\n')

    it('names it by its path under store/, so db/x cannot be read as x', () => {
      expect(findAdapterMechanicEdges(fixture, [])).toEqual([
        'routes/thing.ts -> db/upsert-workspace',
        'routes/thing.ts -> db/workspaces/upsert-row',
        'routes/thing.ts -> doc-cache',
      ])
    })
  })

  // `store/` is where the original mechanics live, and it is not the only place
  // this root keeps something that persists, schedules or lays out disk. The
  // people stores under `security/`, the daemon's own housekeeping and the
  // tenant data layout are the same kind of thing, so a route reaching one is
  // the same defect with a different directory name.
  describe('the matcher sees mechanics that live outside store/', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'arch-lint-adapter-outside-store-'))
    afterAll(() => rmSync(fixture, { recursive: true, force: true }))

    mkdirSync(join(fixture, 'routes', 'document'), { recursive: true })
    mkdirSync(join(fixture, 'mcp'), { recursive: true })
    writeFileSync(
      join(fixture, 'routes', 'people.ts'),
      [
        "import type { MemberProfileStore } from '../security/member-profile-store.js'",
        "import { SESSION_COOKIE } from '../security/sign-in-session-store.js'",
        "import { purgeOldDaemonLogs } from '../../daemon/log-rotation.js'",
        "import { workspaceFilesDir } from '../tenant/data-layout.js'",
        // Policy, parsing and contracts under security/ are not storage: an
        // adapter reading a bearer header or a credential type is translating.
        "import { parseBearerAuthorizationHeader } from '../security/bearer-token.js'",
        "import type { DaemonIdentity } from '../security/daemon-identity.js'",
        // A tenant id is a value, not the layout that places files by it.
        "import { SELF_HOST_TENANT_ID } from '../tenant/id.js'",
        'export const x = [purgeOldDaemonLogs, workspaceFilesDir]',
      ].join('\n'),
    )
    writeFileSync(
      join(fixture, 'routes', 'document', 'nested.ts'),
      "import { tenantRoot } from '../../tenant/data-layout.js'\nexport const y = tenantRoot\n",
    )
    writeFileSync(
      join(fixture, 'routes', '_test-helper.ts'),
      "import { createWorkspaceReplicaKeyStore } from '../security/workspace-replica-key-store.js'\n",
    )
    writeFileSync(
      join(fixture, 'mcp', 'tools.ts'),
      "import { createInvitationStore } from '../security/invitation-store.js'\n",
    )

    it('names each by its directory, so security/x cannot be read as store/x', () => {
      expect(findAdapterMechanicEdges(fixture, [])).toEqual([
        'mcp/tools.ts -> security/invitation-store',
        'routes/document/nested.ts -> tenant/data-layout',
        'routes/people.ts -> daemon/log-rotation',
        'routes/people.ts -> security/member-profile-store',
        'routes/people.ts -> security/sign-in-session-store',
        'routes/people.ts -> tenant/data-layout',
      ])
    })
  })

  // The finder reads the module specifiers the TypeScript AST walk reports —
  // the same ones the sibling di-import scan and every other import scan see —
  // rather than `from '...'` text. Text misses an import that has no `from`
  // and reads a comment as a statement.
  describe('the finder reads import specifiers, not text', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'arch-lint-adapter-ast-'))
    afterAll(() => rmSync(fixture, { recursive: true, force: true }))

    mkdirSync(join(fixture, 'routes'), { recursive: true })
    mkdirSync(join(fixture, 'mcp'), { recursive: true })
    writeFileSync(
      join(fixture, 'routes', 'dynamic.ts'),
      "export async function load() {\n  return import('../store/document-store.js')\n}\n",
    )
    writeFileSync(
      join(fixture, 'routes', 'side-effect.ts'),
      "import '../store/doc-cache.js'\nexport const x = 1\n",
    )
    writeFileSync(
      join(fixture, 'routes', 'reexport.ts'),
      "export { listVersions } from '../store/version-store.js'\n",
    )
    writeFileSync(
      join(fixture, 'routes', 'commented.ts'),
      [
        "// import { listVersions } from '../store/version-store.js'",
        "/* import { x } from '../store/names-store.js' */",
        'export const note = "import { y } from \'../store/file-gc.js\'"',
      ].join('\n'),
    )

    it('counts a dynamic import, a side-effect import and a re-export', () => {
      expect(findAdapterMechanicEdges(fixture, [])).toEqual([
        'routes/dynamic.ts -> document-store',
        'routes/reexport.ts -> version-store',
        'routes/side-effect.ts -> doc-cache',
      ])
    })

    it('does not count a comment or a string that spells an import', () => {
      expect(
        findAdapterMechanicEdges(fixture, []).filter((edge) => edge.startsWith('routes/commented')),
      ).toEqual([])
    })
  })

  // `export/` is where this root renders a stored document and keeps the
  // fonts a render may use: `headless-export` reads the document through the
  // store's module-level handle, and the font modules join the data directory
  // themselves. A route holding one has the operation welded to its storage
  // exactly as a route holding `store/` does.
  describe('the matcher sees the export mechanics', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'arch-lint-adapter-export-'))
    afterAll(() => rmSync(fixture, { recursive: true, force: true }))

    mkdirSync(join(fixture, 'routes', 'document'), { recursive: true })
    mkdirSync(join(fixture, 'mcp'), { recursive: true })
    writeFileSync(
      join(fixture, 'routes', 'export.ts'),
      "import { exportCanvasHeadless } from '../export/headless-export.js'\nexport const x = exportCanvasHeadless\n",
    )
    writeFileSync(
      join(fixture, 'routes', 'document', 'export-svg.ts'),
      "import { installFont } from '../../export/install-font.js'\nexport const y = installFont\n",
    )
    // A sibling route NAMED export is a file, not the `export/` directory.
    writeFileSync(
      join(fixture, 'routes', 'document.ts'),
      "import { exportRoute } from './export.js'\nexport const z = exportRoute\n",
    )

    it('names each by its directory and does not mistake a route called export', () => {
      expect(findAdapterMechanicEdges(fixture, [])).toEqual([
        'routes/document/export-svg.ts -> export/install-font',
        'routes/export.ts -> export/headless-export',
      ])
    })
  })

  // A top-level `server/*.ts` helper that routes import is translation shared
  // between adapters, and when it reaches a mechanic itself every route using
  // it inherits the reach without any of them showing an edge.
  describe('a named adapter helper is scanned as an adapter', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'arch-lint-adapter-helper-'))
    afterAll(() => rmSync(fixture, { recursive: true, force: true }))

    mkdirSync(join(fixture, 'routes'), { recursive: true })
    mkdirSync(join(fixture, 'mcp'), { recursive: true })
    writeFileSync(
      join(fixture, 'routes', 'files.ts'),
      "import { parse } from '../workspace-handle.js'\nexport const x = parse\n",
    )
    writeFileSync(
      join(fixture, 'workspace-handle.ts'),
      "import { workspaceRegistry } from './store/document-store.js'\nexport const parse = workspaceRegistry\n",
    )

    it('reports the helper own edge only when it is named', () => {
      expect(findAdapterMechanicEdges(fixture, [])).toEqual([])
      expect(findAdapterMechanicEdges(fixture, [], [], ['workspace-handle.ts'])).toEqual([
        'workspace-handle.ts -> document-store',
      ])
    })
  })

  it('every named adapter helper exists and is imported by an adapter', () => {
    const importers = ADAPTER_HELPER_FILES.filter((helper) =>
      ['routes', 'mcp'].some((dir) =>
        walk(join(SERVER_DIR, dir), {
          include: (f) => f.endsWith('.ts') && !f.endsWith('.test.ts'),
        }).some((file) =>
          collectRelativeImportEdges(file, readFileSync(file, 'utf8')).some(({ specifier }) =>
            specifier.endsWith(`/${helper.replace(/\.ts$/, '.js')}`),
          ),
        ),
      ),
    )

    expect(
      importers,
      'an entry in ADAPTER_HELPER_FILES is imported by no adapter, or the file is gone — ' +
        'it is not an adapter helper. Delete it.',
    ).toEqual([...ADAPTER_HELPER_FILES])
  })

  // Guarded from both sides too. An exemption is a CLASSIFICATION — "this
  // file is not an adapter" — so it has to keep being true of a file that
  // still exists and still has edges to suppress. One that suppresses nothing
  // is decoration, and reads to the next person as though something was
  // decided.
  it('every exempt file exists and actually has edges the exemption suppresses', () => {
    const unexempted = findAdapterMechanicEdges(
      SERVER_DIR,
      MECHANICS_NOT_SCANNED,
      [],
      ADAPTER_HELPER_FILES,
    )
    const suppressing = ADAPTER_SCAN_EXEMPT_FILES.filter((file) =>
      unexempted.some((edge) => edge.startsWith(`${file} -> `)),
    )

    expect(
      suppressing,
      'an entry in ADAPTER_SCAN_EXEMPT_FILES suppresses nothing — the file was ' +
        'moved, renamed, or no longer reaches a mechanic. Delete it.',
    ).toEqual([...ADAPTER_SCAN_EXEMPT_FILES])
  })

  it('excludes the error taxonomy, which an adapter is entitled to read', () => {
    expect(MECHANICS_NOT_SCANNED).toContain('corrupt-stored-data')
    expect(actual.some((edge) => edge.endsWith('corrupt-stored-data'))).toBe(false)
  })
})
