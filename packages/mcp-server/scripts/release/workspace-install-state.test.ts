// `pnpm deploy --legacy --prod` records "production, no devDependencies" in the
// WORKSPACE's install-state file, not only in the deploy target. The next
// top-level pnpm command then believes the workspace was installed with
// --production and either reinstalls it without devDependencies or, without a
// TTY, aborts with ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY. These cases hold
// generate-npm-sbom.mjs to leaving the developer's install as it found it.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { repoRoot } from '../../src/shared/test-utils/repo-root.js'
import {
  deployArgs,
  preservingWorkspaceInstallState,
  WORKSPACE_STATE_FILE,
} from './workspace-install-state.mjs'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'wb-install-state-'))
  roots.push(root)
  return root
}

function statePath(root: string): string {
  return join(root, 'node_modules', WORKSPACE_STATE_FILE)
}

function writeDevState(root: string, dev: boolean): void {
  mkdirSync(join(root, 'node_modules'), { recursive: true })
  writeFileSync(statePath(root), JSON.stringify({ settings: { dev, production: true } }))
}

function readDev(root: string): unknown {
  return JSON.parse(readFileSync(statePath(root), 'utf-8')).settings.dev
}

describe('preservingWorkspaceInstallState', () => {
  it('restores settings.dev after a step that rewrites it', () => {
    const root = makeRoot()
    writeDevState(root, true)

    const result = preservingWorkspaceInstallState(root, () => {
      writeDevState(root, false)
      return 'deployed'
    })

    expect(result).toBe('deployed')
    expect(readDev(root)).toBe(true)
  })

  it('restores settings.dev when the step throws', () => {
    const root = makeRoot()
    writeDevState(root, true)

    expect(() =>
      preservingWorkspaceInstallState(root, () => {
        writeDevState(root, false)
        throw new Error('deploy failed')
      }),
    ).toThrow('deploy failed')
    expect(readDev(root)).toBe(true)
  })

  it('removes a state file the step wrote where none existed', () => {
    const root = makeRoot()

    preservingWorkspaceInstallState(root, () => writeDevState(root, false))

    expect(existsSync(statePath(root))).toBe(false)
  })
})

// The helper names pnpm's file by a literal, so a pnpm that renamed it would
// leave the helper restoring nothing while every case above stays green. This
// runs the real deploy, with the script's flags, against a workspace with no
// registry dependencies so the install needs no network.
//
// The fixture pins the repo's own `packageManager`, read from the root
// manifest so a pnpm bump moves it too. Unpinned, the pnpm that runs is
// whatever the machine resolves outside the repo — a global install, or
// corepack's last-known-good, which can be a newer major that keeps
// `settings.dev` true after a prod deploy or a version corepack must
// download — and the cases test that pnpm instead of the one the script runs.
const PINNED_PACKAGE_MANAGER: string = JSON.parse(
  readFileSync(join(repoRoot(), 'package.json'), 'utf-8'),
).packageManager
const PINNED_PNPM_VERSION = PINNED_PACKAGE_MANAGER.replace(/^pnpm@/, '').replace(/\+.*$/, '')

// Whether the pinned pnpm can start at all here. Corepack fetches a pinned
// version it has not cached, so with an empty cache and no network the
// premise of the cases below is absent; they skip and say why rather than
// failing on a module corepack never downloaded. Probed, never inferred.
// pnpm on Windows is a `.cmd` shim, which only a shell can launch.
const PNPM_SPAWN = { encoding: 'utf-8', shell: process.platform === 'win32' } as const
const PROBE_TIMEOUT_MS = 60_000

function probePinnedPnpm(): { runs: true } | { runs: false; reason: string } {
  const dir = mkdtempSync(join(tmpdir(), 'wb-pinned-pnpm-'))
  try {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ private: true, packageManager: PINNED_PACKAGE_MANAGER }),
    )
    const result = spawnSync('pnpm', ['--version'], {
      ...PNPM_SPAWN,
      cwd: dir,
      // A corepack fetch that stalls must read as a pnpm that cannot start,
      // not hold test collection open.
      timeout: PROBE_TIMEOUT_MS,
    })
    if (result.status === 0) return { runs: true }
    const output = `${result.stderr}${result.stdout}`.trim()
    // A launcher crash prints the throwing source line first; the error line names the cause.
    const detail =
      result.error?.message ?? output.split('\n').find((line) => /^\w*Error:/.test(line)) ?? output
    return { runs: false, reason: `${PINNED_PACKAGE_MANAGER} cannot start here: ${detail}` }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const PINNED_PNPM = probePinnedPnpm()

describe('a real pnpm deploy --legacy --prod', () => {
  function pnpm(cwd: string, args: string[]): string {
    const result = spawnSync('pnpm', args, { ...PNPM_SPAWN, cwd })
    expect(result.status, `${args.join(' ')}\n${result.stderr}${result.stdout}`).toBe(0)
    return result.stdout
  }

  function requirePinnedPnpm(skip: (note?: string) => void): void {
    if (!PINNED_PNPM.runs) skip(PINNED_PNPM.reason)
  }

  function makeWorkspace(): string {
    const root = makeRoot()
    mkdirSync(join(root, 'packages', 'app'), { recursive: true })
    mkdirSync(join(root, 'packages', 'tool'), { recursive: true })
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'root', private: true, packageManager: PINNED_PACKAGE_MANAGER }),
    )
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n')
    writeFileSync(
      join(root, 'packages', 'app', 'package.json'),
      JSON.stringify({ name: 'app', version: '1.0.0', devDependencies: { tool: 'workspace:*' } }),
    )
    writeFileSync(
      join(root, 'packages', 'tool', 'package.json'),
      JSON.stringify({ name: 'tool', version: '1.0.0' }),
    )
    pnpm(root, ['install', '--offline'])
    return root
  }

  const deploy = (root: string) => pnpm(root, deployArgs('app', join(root, 'out')))

  it('runs the pnpm version the repo pins', ({ skip }) => {
    requirePinnedPnpm(skip)
    const root = makeWorkspace()

    expect(pnpm(root, ['--version']).trim()).toBe(PINNED_PNPM_VERSION)
  }, 60_000)

  it('marks the workspace prod-only when nothing restores it', ({ skip }) => {
    requirePinnedPnpm(skip)
    const root = makeWorkspace()
    expect(readDev(root)).toBe(true)

    deploy(root)

    expect(readDev(root)).toBe(false)
  }, 60_000)

  it('leaves settings.dev true once wrapped', ({ skip }) => {
    requirePinnedPnpm(skip)
    const root = makeWorkspace()

    preservingWorkspaceInstallState(root, () => deploy(root))

    expect(readDev(root)).toBe(true)
  }, 60_000)

  // The other half of the skip: CI is the run whose green is load-bearing, so
  // the pinned pnpm must start there or every case above is silently skipped.
  it.runIf(process.env.CI)('can start the pinned pnpm on CI', () => {
    expect(PINNED_PNPM).toEqual({ runs: true })
  })
})
