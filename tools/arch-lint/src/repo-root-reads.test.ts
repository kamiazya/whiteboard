import { readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isExcludedPath, REPO_ROOT, relativeToRepo, SCAN_ROOTS, walk } from './scan-roots.js'
import { stripComments } from './strip-comments.js'

// A test under `packages/*/src` that reads a file at the REPO ROOT — a
// workflow, the Dockerfile, a docs page, the rule corpus — is a repo-policy
// guard, not a test of the package it sits in. Filed there it runs only when
// that package's project does, so a change to anything else never runs it, and
// its project carries the wall time of a scan it has no reason to own. They
// belong here, in the project the pre-push hook and CI's `test-shared` run
// whole, which is what this file's neighbours already are: scans of other
// places' files that run no product code.
//
// A guard stays in its package only when it cannot move without a tools ->
// packages import, and each such file says which of these it is:
//   - it imports the daemon's own source, so the thing it checks the repo
//     against is computed by product code (a docs example parsed through the
//     daemon's output schema, the env vars the server reads);
//   - it is a property test through the packages' fast-check prelude, which
//     this project takes no dependency on;
//   - it runs or inspects the package's built artifact, not a text file.
//
// The detector is textual, so it has two named blind spots rather than none: a
// root file read through a variable this scan cannot resolve, and a bare
// `'docs/...'` literal (a path too ordinary to match without false positives
// — `docs` is read through the repo-root helper or a `../` count in practice).

/** The first path segment of a repo-root file that is not any package's own. */
const ROOT_ENTRIES: readonly string[] = [
  '.github',
  '.claude',
  '.node-version',
  'docs',
  'Dockerfile',
  'lefthook.yml',
  'package.json',
  'pnpm-workspace.yaml',
]

/** Repo-root-relative literals that are unambiguous without a `../` count. */
const BARE_ROOT_LITERAL =
  /['"`](?:\.github\/|\.claude\/|Dockerfile[\w.-]*|lefthook\.yml|pnpm-workspace\.yaml)/
const REPO_ROOT_HELPER_IMPORT = /from\s+['"][^'"]*\/repo-root(?:\.js)?['"]/
const DOTDOT_LITERAL = /['"`]((?:\.\.\/)+)([^'"`\s]*)['"`]/g

/** Why `source` (the test at repo-relative `file`) reads a repo-root file; empty when it does not. */
export function repoRootReads(file: string, rawSource: string): string[] {
  // A rule file named in prose between backticks is a pointer, not a read.
  const source = stripComments(rawSource)
  const reasons: string[] = []
  if (REPO_ROOT_HELPER_IMPORT.test(source)) reasons.push('imports the repo-root helper')
  if (BARE_ROOT_LITERAL.test(source)) reasons.push('names a repo-root file in a path literal')
  const dir = dirname(join(REPO_ROOT, file))
  for (const match of source.matchAll(DOTDOT_LITERAL)) {
    const inside = relative(REPO_ROOT, resolve(dir, `${match[1]}${match[2]}`))
    if (inside.startsWith('..')) continue
    const first = inside.split(sep)[0] ?? ''
    if (inside === '' || ROOT_ENTRIES.some((entry) => first.startsWith(entry))) {
      reasons.push(`${match[0]} resolves to ${inside === '' ? 'the repo root' : inside}`)
    }
  }
  return reasons
}

/**
 * Every test under `packages/*\/src` that reads a repo-root file and is
 * allowed to, with why. Guarded from both sides: an entry naming a file that is
 * gone, or one that no longer reads the root, fails as stale.
 */
const STAYS_IN_PACKAGE: Readonly<Record<string, string>> = {
  'packages/codec/src/spatial/json-schema.test.ts':
    "snapshots the package's own generated JSON schema into docs/reference; a file snapshot only rejects in a CI-mode run of the package's project",
  'packages/codec/src/spatial/loss-table.test.ts':
    "snapshots the package's own loss ledger into docs/reference, the same generated-artifact shape as json-schema.test.ts",
  'packages/mcp-server/src/cli/docs-commands.test.ts':
    "feeds every `whiteboard ...` command the docs, the README and the app show to the CLI's own dispatcher, which this project cannot import",
  'packages/mcp-server/src/server/docs-operator-output-examples.test.ts':
    "parses a docs page's JSON through the daemon's own output schemas, which this project cannot import",
  'packages/mcp-server/src/server/docs-sign-in-config-examples.test.ts':
    "parses the how-to's sign-in YAML through the daemon's own signInConfigSchema, which this project cannot import",
  'packages/mcp-server/src/server/env-docs-contract.test.ts':
    'the env vars the server reads are computed by importing its own config schema; the docs are only the comparison',
  'packages/mcp-server/src/server/mcp/codex-config.distribution.test.ts':
    "tests this package's own published artifact against the root manifest",
  'packages/mcp-server/src/server/mcp/tarball.distribution.test.ts':
    "tests this package's own published artifact against the root manifest",
  'packages/mcp-server/src/server/release/local-node-version.test.ts':
    'an environment premise — the Node running this suite — not a scan, so it must not newly fail a push from a wrong major',
  'packages/mcp-server/src/server/release/package-shape.test.ts':
    "imports the daemon's CLI dispatcher and checks this package's manifest and bundling shape",
  'packages/mcp-server/src/server/release/publish-dry-run-policy.test.ts':
    "property tests through the packages' fast-check prelude; this project takes no dependency on a package",
  'packages/mcp-server/src/server/release/publish-production-policy.test.ts':
    "property tests through the packages' fast-check prelude; this project takes no dependency on a package",
  'packages/mcp-server/src/server/release/release-gate-matrix.test.ts':
    "property tests through the packages' fast-check prelude; this project takes no dependency on a package",
  'packages/mcp-server/src/server/release/release-supply-chain-policy.test.ts':
    "property tests through the packages' fast-check prelude; this project takes no dependency on a package",
  'packages/mcp-server/src/server/release/sbom-fingerprint.test.ts':
    "imports this package's own scripts/release/sbom-fingerprint.mjs",
  'packages/mcp-server/src/server/release/sbom-policy.test.ts':
    "imports this package's own SBOM fingerprint script and uses the fast-check prelude",
  'packages/mcp-server/src/server/release/web-api-paths-mounted.test.ts':
    "mounts the daemon's real routes and compares them with what apps/web asks for",
  'packages/mcp-server/src/server/routes/error-body-shape.test.ts':
    "imports server-core's apiErrorBodySchema; the root only reaches that sibling package's source",
  'packages/mcp-server/src/server/search/docs-corpus.test.ts':
    "tests the daemon's docs-corpus loader against the real docs tree",
  'packages/mcp-server/src/server/skills-tool-surface.test.ts':
    "imports the daemon's registered tool list to hold the skills against it",
  'packages/mcp-server/src/server/tool-call-examples.contract.test.ts':
    "parses every tool call a skill, the README or a docs page shows through the input schema the daemon's own createServer registers for that tool",
  'packages/mcp-server/src/shared/test-utils/repo-root.test.ts':
    'tests the helper that finds the repo root',
}

// Measured at 815; the floor is a little over half, so churn passes and a walk
// that lost a package does not.
const FILE_FLOOR = 450

function packageTests(): string[] {
  return SCAN_ROOTS.filter((root) => root.startsWith('packages/'))
    .flatMap((root) =>
      walk(join(REPO_ROOT, root), {
        include: (path) => /\.test\.tsx?$/.test(path) && !isExcludedPath(path),
        skip: (_path, name) => name === 'node_modules',
      }),
    )
    .map((path) => relativeToRepo(path))
}

describe('repoRootReads (self-test)', () => {
  const file = 'packages/some-package/src/thing/thing.test.ts'

  it('reports the repo-root helper import', () => {
    expect(
      repoRootReads(file, "import { repoRoot } from '../../shared/test-utils/repo-root.js'"),
    ).toEqual(['imports the repo-root helper'])
  })

  it('reports a root-relative path literal', () => {
    expect(repoRootReads(file, "join(root, '.github/workflows/ci.yml')")).toEqual([
      'names a repo-root file in a path literal',
    ])
    expect(repoRootReads(file, "readFileSync(join(root, 'Dockerfile.server'))")).toHaveLength(1)
  })

  it('reports a ../ count that lands on the root or on a root entry', () => {
    expect(repoRootReads(file, "resolve(dir, '../../../../docs/reference/x.md')")).toEqual([
      "'../../../../docs/reference/x.md' resolves to docs/reference/x.md",
    ])
    expect(repoRootReads(file, "resolve(dir, '../../../..')")).toEqual([
      "'../../../..' resolves to the repo root",
    ])
  })

  it('does not read a comment as a read', () => {
    expect(repoRootReads(file, '// see `.claude/rules/x.md`\n/* and `.github/ci.yml` */')).toEqual(
      [],
    )
  })

  it('leaves a path that stays inside the package, and ordinary module specifiers', () => {
    expect(repoRootReads(file, "import { x } from '../../shared/helper.js'")).toEqual([])
    expect(repoRootReads(file, "resolve(dir, '../../docs/page.md')")).toEqual([])
    expect(repoRootReads(file, "sanitizeHref('docs/a:b')")).toEqual([])
  })
})

describe('tests under packages/*/src that read a repo-root file', () => {
  const reading = new Map(
    packageTests().flatMap((path) => {
      const reasons = repoRootReads(path, readFileSync(join(REPO_ROOT, path), 'utf8'))
      return reasons.length === 0 ? [] : [[path, reasons] as const]
    }),
  )

  it('scanned the package tests it claims to', () => {
    // Present, not assumed: a walk that reached no tests reports no reader.
    expect(packageTests().length).toBeGreaterThan(FILE_FLOOR)
  })

  it('has none outside the allowlist — a repo-policy guard belongs in tools/arch-lint', () => {
    const unlisted = [...reading]
      .filter(([path]) => !(path in STAYS_IN_PACKAGE))
      .map(([path, reasons]) => `${path}: ${reasons.join('; ')}`)
    expect(unlisted).toEqual([])
  })

  it('lists no file that is gone or no longer reads the root', () => {
    const stale = Object.keys(STAYS_IN_PACKAGE).filter((path) => !reading.has(path))
    expect(stale).toEqual([])
  })

  it('gives every allowlisted file a reason', () => {
    const bare = Object.entries(STAYS_IN_PACKAGE)
      .filter(([, why]) => why.trim().length < 20)
      .map(([path]) => path)
    expect(bare).toEqual([])
  })
})
