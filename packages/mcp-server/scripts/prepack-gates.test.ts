import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { repoRoot } from '../src/shared/test-utils/repo-root.js'

// `prepack` chains the three gates with `&&`, so one that silently does
// nothing turns the whole check off while still exiting 0. The entry check
// compared `import.meta.url` to `file://${argv[1]}`, which differs as soon as
// the checkout's path needs URL-encoding — a space is enough.
const GATES = [
  { script: 'verify-web-app-dist.mjs', names: 'dist/web-app/index.html' },
  { script: 'verify-widget-dist.mjs', names: 'dist/widget/canvas-viewer.html' },
  { script: 'verify-export-font-dist.mjs', names: 'dist/assets/fonts' },
] as const
const SIBLINGS = ['copy-export-font-into-dist.mjs', 'prepack-gate-lib.mjs']

describe('the prepack gates', () => {
  let root: string | undefined

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true })
    root = undefined
  })

  // A package root with no dist/ at all, under a directory whose name needs
  // URL-encoding, holding copies of the scripts so each resolves that root.
  // It sits at the checkout's depth, beside the tools/checks helper a script
  // imports by a relative path that climbs out of the package.
  function packageWithSpaceInPath(): string {
    root = mkdtempSync(join(tmpdir(), 'prepack gates-'))
    const packageRoot = join(root, 'packages', 'mcp-server')
    mkdirSync(join(packageRoot, 'scripts'), { recursive: true })
    for (const file of [...GATES.map((gate) => gate.script), ...SIBLINGS]) {
      copyFileSync(join(import.meta.dirname, file), join(packageRoot, 'scripts', file))
    }
    const checks = join(root, 'tools', 'checks', 'src')
    mkdirSync(checks, { recursive: true })
    copyFileSync(
      join(repoRoot(), 'tools/checks/src/is-run-as-script.mjs'),
      join(checks, 'is-run-as-script.mjs'),
    )
    return packageRoot
  }

  it.each(GATES)('$script fails when dist is missing, wherever the checkout lives', (gate) => {
    const packageRoot = packageWithSpaceInPath()
    const result = spawnSync(process.execPath, [join(packageRoot, 'scripts', gate.script)], {
      encoding: 'utf8',
    })
    expect(result.stderr).toContain('prepack gate:')
    expect(result.stderr).toContain(gate.names)
    expect(result.status).toBe(1)
  })

  it.each(GATES)('$script says nothing on stdout, which `npm pack --json` shares', (gate) => {
    const packageRoot = packageWithSpaceInPath()
    const result = spawnSync(process.execPath, [join(packageRoot, 'scripts', gate.script)], {
      encoding: 'utf8',
    })
    expect(result.stdout).toBe('')
  })

  it('passes, saying so on stderr, when the file is there', () => {
    const packageRoot = packageWithSpaceInPath()
    mkdirSync(join(packageRoot, 'dist', 'widget'), { recursive: true })
    writeFileSync(join(packageRoot, 'dist', 'widget', 'canvas-viewer.html'), '<html></html>')
    const result = spawnSync(
      process.execPath,
      [join(packageRoot, 'scripts', 'verify-widget-dist.mjs')],
      { encoding: 'utf8' },
    )
    expect(result.stderr).toContain('canvas-viewer.html present — OK')
    expect(result.stdout).toBe('')
    expect(result.status).toBe(0)
  })

  it('stays quiet when a gate is imported rather than run', () => {
    const packageRoot = packageWithSpaceInPath()
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `await import(${JSON.stringify(join(packageRoot, 'scripts', 'verify-widget-dist.mjs'))})`,
      ],
      { encoding: 'utf8' },
    )
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
  })
})
