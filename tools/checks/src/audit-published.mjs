#!/usr/bin/env node
// Audit what `npx @kamiazya/whiteboard-mcp` installs, not what this
// workspace locks.
//
// `pnpm audit:prod` reads pnpm-lock.yaml, which has pnpm-workspace.yaml's
// `overrides` applied. Overrides are a workspace setting and are not
// published, so a consumer's npm resolves each declared range afresh and
// can land below a floor the workspace audit reports as cleared. This packs
// the package (manifest only — lifecycle scripts off, so no build is
// needed), installs the tarball with npm into an empty directory outside
// the workspace, and audits that resolution at the merge gate's level.
//
// It needs the registry for the resolution itself, not only for the
// advisories, so it runs in the scheduled audit and the release job rather
// than on every PR: a finding here is fixed by moving a DIRECT dependency
// or waiting on upstream, never by an override, and gating unrelated PRs on
// it would block them on work none of them can do.
//
// Usage: node tools/checks/src/audit-published.mjs [--tarball <path.tgz>]

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isRunAsScript } from './is-run-as-script.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const MCP_SERVER = join(REPO_ROOT, 'packages/mcp-server')

// Throws rather than exiting, so the scratch directory is removed on every
// path out of main().
class StepFailed extends Error {}

function runChecked(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf-8', stdio: 'inherit' })
  if (result.status !== 0) {
    throw new StepFailed(`\`${command} ${args.join(' ')}\` failed in ${cwd}`)
  }
}

function packTarball(destination) {
  const result = spawnSync(
    'pnpm',
    ['--config.ignore-scripts=true', 'pack', '--pack-destination', destination],
    { cwd: MCP_SERVER, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'inherit'] },
  )
  process.stdout.write(result.stdout ?? '')
  if (result.status !== 0) throw new StepFailed('`pnpm pack` failed')
  const tarball = (result.stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .findLast((line) => line.endsWith('.tgz'))
  if (tarball === undefined) throw new StepFailed('`pnpm pack` named no tarball')
  return tarball
}

function main() {
  const tarballFlag = process.argv.indexOf('--tarball')
  const scratch = mkdtempSync(join(tmpdir(), 'whiteboard-published-audit-'))
  let status = 1
  try {
    const tarball =
      tarballFlag === -1 ? packTarball(scratch) : resolve(process.argv[tarballFlag + 1] ?? '')
    const probe = join(scratch, 'probe')
    mkdirSync(probe)
    writeFileSync(
      join(probe, 'package.json'),
      `${JSON.stringify({ name: 'whiteboard-mcp-published-audit', private: true })}\n`,
    )
    runChecked(
      'npm',
      ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund', tarball],
      probe,
    )
    const audit = spawnSync('npm', ['audit', '--omit=dev', '--audit-level=high'], {
      cwd: probe,
      encoding: 'utf-8',
      stdio: 'inherit',
    })
    status = audit.status ?? 1
  } catch (error) {
    if (!(error instanceof StepFailed)) throw error
    console.error(`[audit-published] ${error.message}`)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
  process.exit(status)
}

if (isRunAsScript(import.meta.url)) {
  main()
}
