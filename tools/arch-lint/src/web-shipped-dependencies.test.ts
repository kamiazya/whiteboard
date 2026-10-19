// What apps/web's browser bundle carries is declared in `dependencies`, so
// `pnpm audit --prod` audits it.
//
// The audit reads `--prod` as "not devDependencies", which for a bundled app
// is a claim about the BUILD, not the manifest: a package imported by
// shipped source and declared as a devDependency reaches the hosted origin
// and is never audited. workbox-window and vite-plugin-pwa were exactly
// that — `virtual:pwa-register` is vite-plugin-pwa's glue importing
// workbox-window, and the generated service worker bundles workbox-build's
// workbox-* runtime modules (copy-into-mcp-dist.mjs excludes `sw.js`,
// `workbox-<rev>.js` and `assets/workbox-window.*.js` by name).
//
// A type-only import is erased at emit and ships nothing, so it is exempt.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { parseSource } from './ast-helpers.js'
import { REPO_ROOT } from './scan-roots.js'
import { collectModuleSpecifiers } from './scanner.js'
import { isShippedPath, walkSourceFiles } from './source-scan.js'

const WEB = join(REPO_ROOT, 'apps/web')

// A virtual module names no package; these are the packages whose code
// the module's import brings into the bundle.
const VIRTUAL_MODULE_PROVIDERS: Record<string, readonly string[]> = {
  'virtual:pwa-register': ['vite-plugin-pwa', 'workbox-window'],
}

// What workbox-build bundles into the generated `workbox-<rev>.js`: read off
// the built worker's `workbox:<module>:<version>` markers (core, precaching,
// routing, strategies, with this config's generateSW and no runtimeCaching).
// Nothing in src imports them, so they are declared for the audit alone, at
// the version workbox-build is locked to — the copy the build bundles.
const SERVICE_WORKER_RUNTIME = [
  'workbox-core',
  'workbox-precaching',
  'workbox-routing',
  'workbox-strategies',
] as const

// Imported by shipped source and deliberately left a devDependency.
const DEV_DECLARED_ON_PURPOSE: Record<string, string> = {
  'vite-plugin-pwa':
    "the build plugin. What it ships itself is `virtual:pwa-register`'s few lines of " +
    'glue; what that glue and the worker carry is workbox-window and ' +
    'SERVICE_WORKER_RUNTIME, declared below. As a dependency it drags workbox-build, ' +
    'vite and their build toolchain into `pnpm audit --prod` — measured, five high ' +
    'advisories (brace-expansion, source-map-js) in code no user receives',
}

function packageOf(specifier: string): readonly string[] | null {
  const bare = specifier.replace(/\?.*$/, '')
  if (bare.startsWith('.') || bare.startsWith('/')) return null
  if (bare.startsWith('virtual:')) {
    const providers = VIRTUAL_MODULE_PROVIDERS[bare]
    if (providers === undefined)
      throw new Error(`${bare}: no provider recorded for this virtual module`)
    return providers
  }
  const parts = bare.split('/')
  return [bare.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? bare)]
}

function shippedValueImports(): Map<string, string[]> {
  const byPackage = new Map<string, string[]>()
  for (const file of walkSourceFiles(join(WEB, 'src')).filter(isShippedPath)) {
    const source = parseSource(file, readFileSync(file, 'utf-8'))
    for (const reference of collectModuleSpecifiers(source)) {
      if (reference.typeOnly) continue
      for (const pkg of packageOf(reference.specifier) ?? []) {
        byPackage.set(pkg, [...(byPackage.get(pkg) ?? []), file.slice(WEB.length + 1)])
      }
    }
  }
  return byPackage
}

describe("apps/web's shipped imports", () => {
  const imports = shippedValueImports()
  const manifest = JSON.parse(readFileSync(join(WEB, 'package.json'), 'utf-8')) as {
    dependencies?: Record<string, string>
  }

  it('reaches the bundle it is judging', () => {
    expect(imports.size).toBeGreaterThan(20)
    expect([...imports.keys()]).toContain('react')
    expect([...imports.keys()]).toContain('workbox-window')
  })

  it('resolve through `dependencies`, so the prod audit covers them', () => {
    const undeclared = [...imports]
      .filter(([pkg]) => manifest.dependencies?.[pkg] === undefined)
      .filter(([pkg]) => !(pkg in DEV_DECLARED_ON_PURPOSE))
      .map(([pkg, files]) => `${pkg} (imported by ${files[0]})`)
    expect(undeclared).toEqual([])
  })

  it('exempts only shipped imports that really are devDependencies', () => {
    const stale = Object.keys(DEV_DECLARED_ON_PURPOSE).filter(
      (pkg) => !imports.has(pkg) || manifest.dependencies?.[pkg] !== undefined,
    )
    expect(stale).toEqual([])
  })

  it("declares the service worker's bundled runtime at workbox-build's locked version", () => {
    const lock = parseYaml(readFileSync(join(REPO_ROOT, 'pnpm-lock.yaml'), 'utf-8')) as {
      snapshots: Record<string, { dependencies?: Record<string, string> }>
    }
    const workboxBuild = Object.entries(lock.snapshots).filter(([key]) =>
      key.startsWith('workbox-build@'),
    )
    expect(workboxBuild, 'exactly one workbox-build in the lockfile').toHaveLength(1)
    const bundled = workboxBuild[0]?.[1].dependencies ?? {}
    const wrong = SERVICE_WORKER_RUNTIME.filter(
      (pkg) => bundled[pkg] === undefined || manifest.dependencies?.[pkg] !== bundled[pkg],
    ).map((pkg) => `${pkg}: declared ${manifest.dependencies?.[pkg]}, bundled ${bundled[pkg]}`)
    expect(wrong).toEqual([])
  })
})
