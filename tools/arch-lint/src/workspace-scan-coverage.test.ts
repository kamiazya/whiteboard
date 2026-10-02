import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ARCHITECTURE_MAP } from './architecture-map.js'
import {
  BOUNDARY_SCAN_PACKAGES,
  COMPOSITION_ROOTS,
  SHARED_LAYER_PACKAGES,
} from './scan-packages.js'
import { REPO_ROOT } from './scan-roots.js'
import { scanSourceForBoundaryViolations } from './scanner.js'

// What `repo-coverage.test.ts` scans, and the contracts that keep the lists it
// scans with — and the always-on table that restates them — from drifting
// from the workspaces and from ARCHITECTURE_MAP.

const ARCHITECTURE_MAP_DOC = join(REPO_ROOT, '.claude', 'rules', 'architecture-map.md')

/**
 * Workspaces under `packages/`, `apps/` and `tools/` that are in NEITHER list
 * above, each with why a scan of them would be wrong rather than missing.
 *
 * `tools/*` is a workspace glob in `pnpm-workspace.yaml` beside the other two,
 * and `package-cycle-check.ts` reads it, so a workspace added there joins the
 * manifest graph — and was in no per-package scan list and no guard that said
 * so. Both tools are Node programs that read the repo's files, which is what
 * the boundary scan exists to keep OUT of the shared layer.
 *
 * Guarded from both sides below: an entry naming a workspace that is gone, or
 * one a list already covers, fails — so an exemption cannot outlive the reason
 * it records, and a package cannot be left out of every per-package scan by
 * simply not being listed anywhere.
 */
const NOT_BOUNDARY_SCANNED: Readonly<Record<string, string>> = {
  'tools/arch-lint':
    "a Node program that reads every other package's source from the filesystem — `node:fs` " +
    'is its whole job, and it is the scan, not something the scan polices',
  'tools/checks':
    'the CI gate aggregation: a Node script that calls the GitHub API and reads workflow ' +
    'results, outside every runtime the shared layer has to hold on',
}

/** Every directory under `packages/`, `apps/` and `tools/` that carries a package.json. */
function workspaceManifestDirs(): string[] {
  return ['packages', 'apps', 'tools'].flatMap((root) =>
    readdirSync(join(REPO_ROOT, root), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${root}/${entry.name}`)
      .filter((dir) => existsSync(join(REPO_ROOT, dir, 'package.json'))),
  )
}

describe('every workspace is in a per-package scan list', () => {
  const listed = new Set([...SHARED_LAYER_PACKAGES, ...COMPOSITION_ROOTS])

  it('finds the workspaces it is meant to check', () => {
    expect(
      workspaceManifestDirs().length,
      'the workspace walk found almost nothing',
    ).toBeGreaterThan(15)
  })

  it('lists every workspace in SHARED_LAYER_PACKAGES or COMPOSITION_ROOTS, or exempts it with a reason', () => {
    const unscanned = workspaceManifestDirs().filter(
      (dir) => !listed.has(dir) && NOT_BOUNDARY_SCANNED[dir] === undefined,
    )
    expect(
      unscanned,
      'a workspace is in no per-package scan, so a node: import or a banned dependency in it passes ' +
        'arch-lint. Registering it in architecture-map.ts does NOT scan it. Add it to ' +
        'SHARED_LAYER_PACKAGES (or COMPOSITION_ROOTS), or to NOT_BOUNDARY_SCANNED with the reason.',
    ).toEqual([])
  })

  it('keeps every NOT_BOUNDARY_SCANNED entry a real, otherwise unlisted workspace with a reason', () => {
    const dirs = new Set(workspaceManifestDirs())
    const stale = Object.entries(NOT_BOUNDARY_SCANNED).filter(
      ([dir, reason]) => !dirs.has(dir) || listed.has(dir) || reason.trim().length <= 20,
    )
    expect(stale, 'drop the entry, or give it a reason of substance').toEqual([])
  })
})

describe('per-file boundary exemptions (exemptBoundaryFiles)', () => {
  const entries = BOUNDARY_SCAN_PACKAGES.flatMap((packageDir) => {
    const name = JSON.parse(readFileSync(join(REPO_ROOT, packageDir, 'package.json'), 'utf-8')).name
    return Object.entries(ARCHITECTURE_MAP[name]?.exemptBoundaryFiles ?? {}).map(
      ([file, exemption]) => ({ packageDir, file, ...exemption }),
    )
  })

  it('finds the exemptions it exists to guard', () => {
    // canvas-viewer's build-time module, facet-ui's popover, daemon-client's
    // api-client: three files that used to be package-wide kinds.
    expect(entries.length, 'the per-file exemptions were not found').toBeGreaterThanOrEqual(3)
  })

  // The same both-sided contract as every allowlist here: an exemption whose
  // file is gone, or no longer commits the use, would keep exempting nothing
  // and read as a precaution rather than as a hole.
  it('every entry names a file that still contains a use of each exempted kind', () => {
    const stale = entries.flatMap(({ packageDir, file, kinds, reason }) => {
      const path = join(REPO_ROOT, packageDir, 'src', file)
      if (!existsSync(path)) return [{ packageDir, file, why: 'file is gone' }]
      if (reason.trim().length <= 20) return [{ packageDir, file, why: 'no reason given' }]
      const found = new Set(
        scanSourceForBoundaryViolations(path, readFileSync(path, 'utf-8')).map((v) => v.kind),
      )
      return kinds
        .filter((kind) => !found.has(kind))
        .map((kind) => ({ packageDir, file, why: `no longer contains a ${kind}` }))
    })
    expect(stale, 'drop the entry, or the part of it that nothing uses').toEqual([])
  })
})

/**
 * The table in architecture-map.md is the contract every session reads and
 * ARCHITECTURE_MAP is what the scans enforce; they were two hand-kept copies
 * and disagreed in six rows (loro-adapter listed `ports`, plugin-visual a
 * `lucide-react` the map records as deliberately gone, and three rows spelled
 * a package by a name nothing resolves, `render` and `crdt`).
 */
describe('architecture-map.md table agrees with ARCHITECTURE_MAP', () => {
  const doc = readFileSync(ARCHITECTURE_MAP_DOC, 'utf-8')
  const shortName = (name: string): string => name.replace('@kamiazya/whiteboard-', '')
  const workspaceNames = new Set(Object.keys(ARCHITECTURE_MAP).map(shortName))

  const rows = doc
    .split('\n')
    .filter((line) => /^\| `(?:packages|apps)\//.test(line))
    .map((line) => {
      const [dir, , deps] = line
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim())
      const packageDir = (dir as string).replaceAll('`', '')
      const manifest = JSON.parse(
        readFileSync(join(REPO_ROOT, packageDir, 'package.json'), 'utf-8'),
      )
      // `zod only` is prose around one name, and a token with a space is
      // prose outright (`port impls`): the column mixes both with names.
      const tokens = (deps as string)
        .split(/[,+]/)
        .map((token) =>
          token
            .replaceAll('`', '')
            .replace(/ only$/, '')
            .trim(),
        )
        .filter((token) => token !== '' && !token.includes(' '))
      return { name: manifest.name as string, tokens }
    })

  it('has one row for every package ARCHITECTURE_MAP maps', () => {
    expect(rows.map((row) => row.name).sort()).toEqual(Object.keys(ARCHITECTURE_MAP).sort())
  })

  it('lists, per row, exactly the workspace packages the map allows', () => {
    const drift = rows.flatMap(({ name, tokens }) => {
      const listed = tokens.filter((token) => workspaceNames.has(token)).sort()
      const allowed = (ARCHITECTURE_MAP[name]?.allowedInternalDeps ?? []).map(shortName).sort()
      return JSON.stringify(listed) === JSON.stringify(allowed)
        ? []
        : [{ name, table: listed, map: allowed }]
    })
    expect(
      drift,
      'a "Checked dependencies" cell names workspace packages differently from allowedInternalDeps. ' +
        'The cell spells packages by their manifest name minus `@kamiazya/whiteboard-`.',
    ).toEqual([])
  })

  it('names only third-party packages the map records for that row', () => {
    const unknown = rows.flatMap(({ name, tokens }) => {
      const recorded = ARCHITECTURE_MAP[name]?.allowedThirdParty ?? []
      return tokens
        .filter((token) => !workspaceNames.has(token))
        .filter((token) => !recorded.some((dep) => dep === token || dep.startsWith(`${token}-`)))
        .map((token) => ({ name, token }))
    })
    expect(
      unknown,
      'a cell names something that is neither a workspace package nor in allowedThirdParty ' +
        '(`remark` stands for the remark-* family)',
    ).toEqual([])
  })
})
