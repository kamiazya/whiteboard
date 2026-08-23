// R5 of the MCP-UI retirement (ADR 0001): the legacy browser-app build
// pipeline (vite.config.ts, build:app, the vite-driven dev script) is
// deleted. This test maps that completion criterion to a concrete assertion
// instead of relying on "pnpm build is green" as a proxy — a stray
// `build:app` script or a resurrected vite.config.ts would pass a green
// build but silently reintroduce the retired pipeline.

import { existsSync, globSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { USAGE } from '../../cli/dispatcher.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
// __dirname → packages/mcp-server/src/server/release
const PACKAGE_ROOT = resolve(__dirname, '../../..')
const mcpPackage = JSON.parse(readFileSync(resolve(PACKAGE_ROOT, 'package.json'), 'utf-8')) as {
  scripts?: Record<string, string>
  sideEffects?: string[]
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

const WORKSPACE_SCOPE = '@kamiazya/whiteboard-'

// canvas-viewer is consumed as a built widget artifact copied off disk by
// scripts/copy-widget-into-dist.mjs, never imported from source — so it is
// the one workspace package that legitimately has no noExternal entry.
const NOT_BUNDLED = new Set([`${WORKSPACE_SCOPE}canvas-viewer`])

describe('packages/mcp-server package shape (legacy build pipeline retired)', () => {
  it('has no build:app script', () => {
    expect(mcpPackage.scripts?.['build:app']).toBeUndefined()
  })

  it('build runs build:server plus the MCP Apps widget and export font copy steps, nothing else', () => {
    expect(mcpPackage.scripts?.build).toBe(
      'pnpm build:server && node scripts/copy-widget-into-dist.mjs && node scripts/copy-export-font-into-dist.mjs',
    )
  })

  it('dev does not spawn vite', () => {
    expect(mcpPackage.scripts?.dev ?? '').not.toContain('vite')
  })

  it('sideEffects is exactly the mcp server entry, no legacy browser-app CSS glob', () => {
    expect(mcpPackage.sideEffects).toEqual(['./dist/server/mcp/index.js'])
  })

  it('vite.config.ts does not exist', () => {
    expect(existsSync(resolve(PACKAGE_ROOT, 'vite.config.ts'))).toBe(false)
  })
})

// The @kamiazya/whiteboard-* workspace packages are private and never
// published, so a published `dependencies` entry for one is unresolvable:
// `pnpm add <tarball>` fails with ERR_PNPM_FETCH_404 for every consumer.
// tsup inlines them into dist instead (packaging decision B, see
// tsup.config.ts). Without these two assertions the only thing that catches
// the mistake is the packed-tarball smoke, which needs a full build plus a
// real install — these fail in milliseconds instead.
describe('private workspace packages are bundled, never published as deps', () => {
  const workspaceDeps = (record: Record<string, string> | undefined): string[] =>
    Object.keys(record ?? {}).filter((name) => name.startsWith(WORKSPACE_SCOPE))

  it('declares no workspace package in dependencies', () => {
    expect(workspaceDeps(mcpPackage.dependencies)).toEqual([])
  })

  it('lists every source-imported workspace devDependency in tsup noExternal', () => {
    const tsupConfig = readFileSync(resolve(PACKAGE_ROOT, 'tsup.config.ts'), 'utf-8')
    const expected = workspaceDeps(mcpPackage.devDependencies).filter(
      (name) => !NOT_BUNDLED.has(name),
    )
    // Guards the mirror failure of the case above: a workspace dep that tsup
    // does not inline leaves dist importing a specifier nothing can resolve.
    expect(expected.length).toBeGreaterThan(0)
    for (const name of expected) {
      expect(tsupConfig).toContain(`'${name}'`)
    }
  })
})

// A dynamic `import()` of a third-party module is the one dependency edge
// neither tsup nor typecheck can see: tsup leaves the specifier in the
// bundle for the runtime to resolve, and TypeScript is satisfied by the
// types resolving in the workspace. So a package the ROOT declares as a
// devDependency works in every local check and every CI job, and throws
// MODULE_NOT_FOUND for the installed user — which is exactly what happened
// to @huggingface/transformers behind WHITEBOARD_SEMANTIC_SEARCH=1.
describe('runtime imports are declared by this package, not inherited from the root', () => {
  const declared = new Set([
    ...Object.keys(mcpPackage.dependencies ?? {}),
    ...Object.keys(mcpPackage.optionalDependencies ?? {}),
    ...Object.keys(mcpPackage.peerDependencies ?? {}),
  ])

  it('declares every third-party module src/ dynamically imports', () => {
    const sources = globSync('src/**/*.ts', { cwd: PACKAGE_ROOT })
      .filter((path) => !path.endsWith('.test.ts'))
      .map((path) => resolve(PACKAGE_ROOT, path))
    expect(sources.length, 'the source glob matched nothing').toBeGreaterThan(100)
    const undeclared = new Set<string>()
    for (const path of sources) {
      for (const found of readFileSync(path, 'utf-8').matchAll(
        /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
      )) {
        const specifier = found[1]
        if (specifier.startsWith('.') || specifier.startsWith('node:')) continue
        // Workspace packages are inlined into dist by tsup (see the
        // noExternal assertions above), so they are deliberately absent.
        if (specifier.startsWith(WORKSPACE_SCOPE)) continue
        const packageName = specifier.startsWith('@')
          ? specifier.split('/').slice(0, 2).join('/')
          : (specifier.split('/')[0] as string)
        if (!declared.has(packageName)) undeclared.add(packageName)
      }
    }
    expect([...undeclared]).toEqual([])
  })

  // 384MB installed, measured with a clean `npm install` (onnxruntime-node
  // 211MB + onnxruntime-web 130MB dominate; the 113MB of model weights are
  // a separate download on top). Semantic search is OFF by default, so that
  // must not land on an install that never asked for it. `dependencies` and
  // `optionalDependencies` both would — npm installs optional deps unless
  // they FAIL, which is a different thing from opting out. An optional peer
  // is not auto-installed, and still states the version range it needs.
  it('keeps the semantic-search runtime an optional peer, so a default install stays small', () => {
    const embeddings = '@huggingface/transformers'
    expect(mcpPackage.dependencies?.[embeddings]).toBeUndefined()
    expect(mcpPackage.optionalDependencies?.[embeddings]).toBeUndefined()
    expect(mcpPackage.peerDependencies?.[embeddings]).toBeDefined()
    expect(mcpPackage.peerDependenciesMeta?.[embeddings]?.optional).toBe(true)
  })
})

// A `whiteboard …` line inside a fenced block is a command a reader will
// copy. The semantic-search how-to told them to run one that only existed
// as a repo script — it was never in the published CLI at all, so the
// feature it enabled could not be turned on by anyone who installed the
// package. USAGE is the dispatcher's own list; deriving from it means the
// docs cannot name a command the CLI does not route.
describe('documented CLI commands are commands the CLI routes', () => {
  it('every `whiteboard …` line in a docs code block appears in USAGE', () => {
    const usageCommands = USAGE.split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('whiteboard '))

    const repoRoot = resolve(PACKAGE_ROOT, '../..')
    const docs = [
      ...globSync('docs/**/*.md', { cwd: repoRoot }),
      'README.md',
      'CONTRIBUTING.md',
    ].filter((relPath) => existsSync(resolve(repoRoot, relPath)))

    const undocumented: string[] = []
    let checked = 0
    for (const relPath of docs) {
      let inFence = false
      for (const line of readFileSync(resolve(repoRoot, relPath), 'utf-8').split('\n')) {
        if (line.trim().startsWith('```')) {
          inFence = !inFence
          continue
        }
        const command = line.trim()
        if (!inFence || !command.startsWith('whiteboard ')) continue
        checked += 1
        // Compare on the command words only: USAGE spells out the flags and
        // a doc example uses a real value for each, so matching whole lines
        // would compare two different things.
        const words = command.split(/\s+/).slice(0, 3).join(' ')
        if (!usageCommands.some((usage) => usage.startsWith(words))) {
          undocumented.push(`${relPath}: ${command}`)
        }
      }
    }

    expect(checked, 'the fenced-block scan found no whiteboard commands').toBeGreaterThan(0)
    expect(undocumented).toEqual([])
  })
})
