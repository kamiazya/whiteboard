import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// This package is the ONE workspace member still on TypeScript 6, and the pin
// is not a leftover: `tsup` emits the published `.d.ts` through a
// rollup-plugin-dts it VENDORS into its own `dist/rollup.js`, at 6.1.1 — a
// version that reads the JS compiler API TypeScript 7 removed from the
// `typescript` root export. Measured on 7.0.2, both of tsup's implementations
// die there: `dts` on `Cannot read properties of undefined (reading
// 'useCaseSensitiveFileNames')`, `experimentalDts` on
// `parseJsonConfigFileContent is not a function`. Because the plugin is
// inlined rather than resolved, no override or patch reaches it.
//
// The bundling is load-bearing, so "just emit with tsc" is not the escape:
// tsup's `noExternal` pulls nine private workspace packages into this dist,
// and a plain declaration emit would leave the published types importing
// `@kamiazya/whiteboard-model` — a package no consumer can resolve.
//
// So the pin stands until tsup vendors rollup-plugin-dts >= 6.5.0, which is
// exactly where `typescript: ^7` and the `@typescript/typescript6` peer arrive
// (6.4.0 still declares `^4.5||^5||^6`). This guard is what notices that
// happening. Without it the pin is a comment nobody re-reads, and this package
// keeps typechecking on the slow compiler for as long as everyone forgets —
// 9s of the workspace's 21s, the largest single share.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../../..')

/** The release where rollup-plugin-dts started accepting TypeScript 7. */
const TS7_CAPABLE_DTS_PLUGIN = [6, 5, 0] as const

function parseVersion(version: string): readonly number[] {
  return version.split('.').map(Number)
}

/**
 * Pure half, so the threshold itself is testable without a matching tsup
 * release to hand — a comparison nothing exercises is how an off-by-one in a
 * guard survives.
 */
function pinStillRequired(vendoredPluginVersion: string): boolean {
  const actual = parseVersion(vendoredPluginVersion)
  for (const [index, floor] of TS7_CAPABLE_DTS_PLUGIN.entries()) {
    const part = actual[index] ?? 0
    if (part !== floor) return part < floor
  }
  return false
}

/**
 * The version tsup inlined, read from its bundle's own module banner.
 *
 * Throws rather than answering a default: a probe that stops finding its
 * subject must fail as a broken probe, not report the pin as still justified.
 */
function vendoredDtsPluginVersion(): string {
  const require = createRequire(join(REPO_ROOT, 'packages/mcp-server/index.js'))
  const bundle = join(dirname(require.resolve('tsup/package.json')), 'dist/rollup.js')
  const found = [
    ...new Set(
      [...readFileSync(bundle, 'utf8').matchAll(/rollup-plugin-dts@(\d+\.\d+\.\d+)/g)].map(
        (match) => match[1] as string,
      ),
    ),
  ]
  if (found.length !== 1) {
    throw new Error(
      `expected exactly one rollup-plugin-dts version banner in ${bundle}, found ${JSON.stringify(found)} — the probe this guard rests on has broken, so nothing can be concluded about the TypeScript pin`,
    )
  }
  return found[0] as string
}

function mcpServerTypescriptPin(): string | undefined {
  const manifest = JSON.parse(
    readFileSync(join(REPO_ROOT, 'packages/mcp-server/package.json'), 'utf8'),
  ) as { devDependencies?: Record<string, string> }
  return manifest.devDependencies?.typescript
}

describe('the TypeScript 6 pin on this package', () => {
  it('reads the version tsup vendored', () => {
    expect(vendoredDtsPluginVersion()).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('knows which plugin versions can take TypeScript 7', () => {
    expect(pinStillRequired('6.1.1')).toBe(true)
    expect(pinStillRequired('6.4.0')).toBe(true)
    expect(pinStillRequired('6.5.0')).toBe(false)
    expect(pinStillRequired('6.5.1')).toBe(false)
    expect(pinStillRequired('7.0.0')).toBe(false)
  })

  it('is still needed, and is still a pin', () => {
    const vendored = vendoredDtsPluginVersion()
    expect(
      pinStillRequired(vendored),
      `tsup now vendors rollup-plugin-dts ${vendored}, which takes TypeScript 7 — drop this package's \`typescript\` pin back to \`catalog:\`, add \`@typescript/typescript6\` as a devDependency for the plugin's peer, and confirm \`pnpm build\` still emits dist/server/mcp/index.d.ts`,
    ).toBe(true)
    expect(
      mcpServerTypescriptPin(),
      'this package must pin `typescript` off the catalog while the vendored dts plugin cannot read TypeScript 7',
    ).toMatch(/^\^?6\./)
  })
})
