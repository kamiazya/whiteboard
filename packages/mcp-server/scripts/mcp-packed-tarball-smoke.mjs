#!/usr/bin/env node
// Smoke test the actual npm tarball contract by packing, installing into a
// fresh temp directory, and running the installed entrypoint.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(__dirname, '..')
const repoRoot = resolve(packageRoot, '../..')
const installDir = mkdtempSync(join(tmpdir(), 'whiteboard-tarball-install-'))
const npmCacheDir = mkdtempSync(join(tmpdir(), 'whiteboard-npm-cache-'))

function fail(message) {
  console.error(`[tarball-smoke] FAIL: ${message}`)
  cleanup(1)
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: packageRoot,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, npm_config_cache: npmCacheDir },
    ...options,
  })

  if (result.status !== 0) {
    const stderr = result.stderr?.trim()
    const stdout = result.stdout?.trim()
    fail(
      `${command} ${args.join(' ')} exited with ${result.status ?? 'null'}${
        stderr ? `\n${stderr}` : stdout ? `\n${stdout}` : ''
      }`,
    )
  }

  return result
}

function cleanup(code) {
  rmSync(installDir, { recursive: true, force: true })
  rmSync(npmCacheDir, { recursive: true, force: true })
  if (packedTarballPath) {
    rmSync(packedTarballPath, { force: true })
  }
  process.exit(code)
}

let packedTarballPath = null

process.on('SIGINT', () => cleanup(130))
process.on('SIGTERM', () => cleanup(143))

const packResult = run('npm', ['pack', '--json'])
const packJson = JSON.parse(packResult.stdout)
const packedTarball = packJson[0]?.filename

if (!packedTarball) {
  fail(`npm pack --json did not return a filename: ${packResult.stdout}`)
}

packedTarballPath = resolve(packageRoot, packedTarball)
if (!existsSync(packedTarballPath)) {
  fail(`packed tarball was not created: ${packedTarballPath}`)
}

writeFileSync(
  resolve(installDir, 'package.json'),
  JSON.stringify({ name: 'whiteboard-tarball-smoke', private: true }, null, 2),
)

console.log(`[tarball-smoke] pack → ${packedTarballPath}`)
console.log(`[tarball-smoke] install dir → ${installDir}`)

run(
  'pnpm',
  ['add', '--prefer-offline', '--package-import-method=copy', packedTarballPath],
  { cwd: installDir },
)

const installedPackageRoot = resolve(installDir, 'node_modules/@kamiazya/whiteboard-mcp')
const installedEntry = resolve(installedPackageRoot, 'dist/server/mcp/index.js')
const installedBin = resolve(
  installDir,
  process.platform === 'win32' ? 'node_modules/.bin/whiteboard-mcp.cmd' : 'node_modules/.bin/whiteboard-mcp',
)

if (!existsSync(installedPackageRoot)) {
  fail(`package was not installed: ${installedPackageRoot}`)
}
if (!existsSync(installedEntry)) {
  fail(`installed entrypoint missing: ${installedEntry}`)
}
if (!existsSync(installedBin)) {
  fail(`installed bin missing: ${installedBin}`)
}

console.log(`[tarball-smoke] installed package → ${installedPackageRoot}`)
console.log(`[tarball-smoke] installed entry → ${installedEntry}`)

const smoke = spawnSync(
  'node',
  [resolve(packageRoot, 'scripts/mcp-e2e-smoke.mjs'), `--entry=${installedEntry}`],
  {
    cwd: repoRoot,
    stdio: 'inherit',
    env: process.env,
  },
)

if (smoke.status !== 0) {
  fail(`installed tarball smoke failed with exit code ${smoke.status ?? 'null'}`)
}

console.log('[tarball-smoke] installed tarball entrypoint OK')
cleanup(0)
