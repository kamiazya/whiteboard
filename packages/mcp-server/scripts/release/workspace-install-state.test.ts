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
import {
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
// registry dependencies so it needs no network.
describe('a real pnpm deploy --legacy --prod', () => {
  function pnpm(cwd: string, args: string[]) {
    const result = spawnSync('pnpm', args, { cwd, encoding: 'utf-8' })
    expect(result.status, `${args.join(' ')}\n${result.stderr}${result.stdout}`).toBe(0)
  }

  function makeWorkspace(): string {
    const root = makeRoot()
    mkdirSync(join(root, 'packages', 'app'), { recursive: true })
    mkdirSync(join(root, 'packages', 'tool'), { recursive: true })
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'root', private: true }))
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

  const deploy = (root: string) =>
    pnpm(root, [
      '--filter',
      'app',
      'deploy',
      '--legacy',
      '--prod',
      '--ignore-scripts',
      join(root, 'out'),
    ])

  it('marks the workspace prod-only when nothing restores it', () => {
    const root = makeWorkspace()
    expect(readDev(root)).toBe(true)

    deploy(root)

    expect(readDev(root)).toBe(false)
  }, 60_000)

  it('leaves settings.dev true once wrapped', () => {
    const root = makeWorkspace()

    preservingWorkspaceInstallState(root, () => deploy(root))

    expect(readDev(root)).toBe(true)
  }, 60_000)
})
