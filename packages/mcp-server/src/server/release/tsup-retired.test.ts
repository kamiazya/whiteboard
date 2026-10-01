// The published bundle is built by tsdown. `tsup` kept being named as the
// bundler in prose, a workflow comment and a rule that a session reads before
// touching the build — and `noExternal`, the option those sentences exist to
// warn about, is spelled the same in both, so nothing ever read wrong enough
// to be noticed. A reader who goes looking for a tsup config finds none.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { trackedFiles } from '../../shared/test-utils/tracked-files.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../../..')

const MAY_NAME_TSUP: Record<string, string> = {
  'pnpm-workspace.yaml':
    'records WHY mcp-server was once pinned to TypeScript 6 — tsup vendored a rollup-plugin-dts — and that the pin is gone',
  '.claude/scripts/stale-issues-lib.test.mjs':
    'a fixture path: stale-issues-lib reports on any file an issue names, and the test needs one that no longer exists',
}

const scanned = trackedFiles(ROOT, '*.md', '*.mjs', '*.yml', '*.yaml')
const TSUP = /\btsup\b/i

describe('tsup is retired as the name of the bundler', () => {
  it('no tracked package depends on it', () => {
    const manifests = trackedFiles(ROOT, 'package.json', '**/package.json')
    expect(manifests.length).toBeGreaterThan(15)
    const dependents = manifests.filter((path) => {
      const pkg = JSON.parse(readFileSync(join(ROOT, path), 'utf-8')) as Record<
        string,
        Record<string, string> | undefined
      >
      return ['dependencies', 'devDependencies', 'peerDependencies'].some(
        (field) => pkg[field]?.tsup,
      )
    })
    expect(dependents, 'tsup is back: delete this guard with its reason').toEqual([])
  })

  it('is named in no Markdown, script or workflow outside the documented exemptions', () => {
    expect(scanned.length).toBeGreaterThan(250)
    expect(scanned).toContain('.github/workflows/ci.yml')
    const offenders = scanned
      .filter((path) => !(path in MAY_NAME_TSUP))
      .filter((path) => TSUP.test(readFileSync(join(ROOT, path), 'utf-8')))
    expect(offenders, 'the bundler is tsdown (packages/mcp-server/tsdown.config.ts)').toEqual([])
  })

  it('every exemption still names tsup, so none outlives its reason', () => {
    for (const path of Object.keys(MAY_NAME_TSUP)) {
      expect(scanned, `${path} is no longer scanned`).toContain(path)
      expect(readFileSync(join(ROOT, path), 'utf-8'), `${path}: drop its exemption`).toMatch(TSUP)
    }
  })
})
