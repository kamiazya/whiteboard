import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { REPO_ROOT } from './scan-roots.js'

// ADR-0054 decision 13: npm `loro-crdt` and the Rust `loro` crate move in
// lock-step, because a skew makes every differential failure ambiguous (is it
// the engine or the version?). A manifest pin alone does not hold it:
// `loro = "=1.17.1"` leaves `loro-internal` and the rest of loro's own crates
// to float to the newest release, which Cargo.lock then records, so the
// lockfile is what is read. The versions of the loro crates the lock must
// agree on are the ones the pinned `loro` release declares; a crate loro
// versions on its own (`loro-delta`, `loro-kv-store`, ...) is not compared.

/** Cargo.lock's `loro` crates that are versioned with the engine itself. */
const LOCKED_WITH_ENGINE = ['loro', 'loro-internal'] as const

/** What the catalog pins `loro-crdt` to. */
function catalogVersion(workspaceYaml: string): string | undefined {
  const catalog = (parse(workspaceYaml) as { catalog?: Record<string, string> }).catalog
  return catalog?.['loro-crdt']
}

/** Every version of `loro-crdt` pnpm-lock.yaml resolved, from its `packages:` keys. */
function lockedNpmVersions(pnpmLock: string): string[] {
  const packages = (parse(pnpmLock) as { packages?: Record<string, unknown> }).packages ?? {}
  return Object.keys(packages)
    .map((key) => /^loro-crdt@(.+)$/.exec(key)?.[1])
    .filter((version): version is string => version !== undefined)
}

/** The versions Cargo.lock holds for a crate. */
function lockedCrateVersions(cargoLock: string, name: string): string[] {
  const out: string[] = []
  for (const block of cargoLock.split(/^\[\[package\]\]$/m).slice(1)) {
    if (new RegExp(`^name = "${name}"$`, 'm').test(block)) {
      const version = /^version = "([^"]+)"$/m.exec(block)?.[1]
      if (version !== undefined) out.push(version)
    }
  }
  return out
}

/** Every way the two lockfiles and the catalog disagree about the loro version. */
function skews(inputs: { workspaceYaml: string; pnpmLock: string; cargoLock: string }): string[] {
  const wanted = catalogVersion(inputs.workspaceYaml)
  if (wanted === undefined) return ['pnpm-workspace.yaml: the catalog does not pin loro-crdt']
  const found: string[] = []
  const npm = lockedNpmVersions(inputs.pnpmLock)
  if (npm.length === 0) found.push('pnpm-lock.yaml: no loro-crdt resolved')
  for (const version of npm) {
    if (version !== wanted) found.push(`pnpm-lock.yaml: loro-crdt ${version}, catalog ${wanted}`)
  }
  for (const name of LOCKED_WITH_ENGINE) {
    const versions = lockedCrateVersions(inputs.cargoLock, name)
    if (versions.length === 0) found.push(`Cargo.lock: no ${name} locked`)
    for (const version of versions) {
      if (version !== wanted) {
        found.push(`Cargo.lock: ${name} ${version}, npm loro-crdt ${wanted}`)
      }
    }
  }
  return found
}

const read = (file: string) => readFileSync(join(REPO_ROOT, file), 'utf8')

describe('loro lock-step', () => {
  it('npm loro-crdt and the Rust loro crates resolve to one version in both lockfiles', () => {
    expect(
      skews({
        workspaceYaml: read('pnpm-workspace.yaml'),
        pnpmLock: read('pnpm-lock.yaml'),
        cargoLock: read('Cargo.lock'),
      }),
    ).toEqual([])
  })

  it('pins the Rust loro exactly in the root manifest', () => {
    expect(read('Cargo.toml')).toMatch(/^loro = "=\d+\.\d+\.\d+"$/m)
  })

  describe('names a skew from either side', () => {
    const workspaceYaml = 'catalog:\n  loro-crdt: "1.17.1"\n'
    const pnpmLock = 'packages:\n\n  loro-crdt@1.17.1:\n    resolution: {}\n'
    const cargoLock = [
      '[[package]]\nname = "loro"\nversion = "1.17.1"\n',
      '[[package]]\nname = "loro-internal"\nversion = "1.17.1"\n',
      '[[package]]\nname = "loro-delta"\nversion = "1.13.0"\n',
    ].join('\n')

    it('is quiet when every side agrees, and sees the loro crates it compares', () => {
      expect(skews({ workspaceYaml, pnpmLock, cargoLock })).toEqual([])
      expect(lockedCrateVersions(cargoLock, 'loro')).toEqual(['1.17.1'])
      expect(lockedNpmVersions(pnpmLock)).toEqual(['1.17.1'])
    })

    it('names the Rust loro when it drifts', () => {
      const drifted = cargoLock.replace(
        'name = "loro"\nversion = "1.17.1"',
        'name = "loro"\nversion = "1.18.0"',
      )
      expect(skews({ workspaceYaml, pnpmLock, cargoLock: drifted })).toEqual([
        'Cargo.lock: loro 1.18.0, npm loro-crdt 1.17.1',
      ])
    })

    it('names loro-internal when it floats past the pin', () => {
      const floated = cargoLock.replace(
        'name = "loro-internal"\nversion = "1.17.1"',
        'name = "loro-internal"\nversion = "1.18.0"',
      )
      expect(skews({ workspaceYaml, pnpmLock, cargoLock: floated })).toEqual([
        'Cargo.lock: loro-internal 1.18.0, npm loro-crdt 1.17.1',
      ])
    })

    it('names the npm side when the lockfile drifts from the catalog', () => {
      expect(
        skews({ workspaceYaml, pnpmLock: pnpmLock.replace('1.17.1', '1.18.0'), cargoLock }),
      ).toEqual(['pnpm-lock.yaml: loro-crdt 1.18.0, catalog 1.17.1'])
    })

    it('refuses a lock that holds no loro at all', () => {
      expect(skews({ workspaceYaml, pnpmLock, cargoLock: '' })).toEqual([
        'Cargo.lock: no loro locked',
        'Cargo.lock: no loro-internal locked',
      ])
    })
  })
})
