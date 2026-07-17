import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { runE2eCheckpointSmoke } from './mcp-e2e-checkpoint.smoke-impl.js'

interface RunPackedTarballSmokeOptions {
  packageRoot: string
  repoRoot: string
}

function spawnChecked(
  command: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv },
): void {
  const result = spawnSync(command, args, {
    cwd: opts.cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: opts.env,
  })
  if (result.status !== 0) {
    const stderr = (result.stderr as string)?.trim()
    const stdout = (result.stdout as string)?.trim()
    throw new Error(
      `[tarball-smoke] ${command} ${args.join(' ')} exited with ${result.status ?? 'null'}${
        stderr ? `\n${stderr}` : stdout ? `\n${stdout}` : ''
      }`,
    )
  }
}

// R5 of the MCP-UI retirement (ADR 0001): the retired legacy browser-app
// build output must never enter the published tarball again, and
// dist/web-app (the canonical apps/web build) must always be present.
// Checked directly against the packed tarball's file list rather than the
// source tree, since `files`/`sideEffects` config drift or a stray build
// artifact would otherwise only surface as a runtime 404 after publish.
// Exported (and split from the `tar -tzf` invocation) so the two failure
// branches can be exercised with a synthetic entry list, not just via the
// end-to-end happy-path smoke.
export function assertTarballFileList(entries: readonly string[]): void {
  const distAppEntries = entries.filter((e) => e.startsWith('package/dist/app/'))
  if (distAppEntries.length > 0) {
    throw new Error(
      `[tarball-smoke] packed tarball contains retired dist/app/ entries: ${distAppEntries.join(', ')}`,
    )
  }
  if (!entries.includes('package/dist/web-app/index.html')) {
    throw new Error('[tarball-smoke] packed tarball is missing dist/web-app/index.html')
  }
}

// The installed tarball ships only `dist/`, never `src/`. If the ambient
// environment carries WHITEBOARD_DEV=1 (e.g. a CI job that runs this smoke
// alongside a src-mode e2e check under the same env block), ensureDaemon
// would try to spawn `node --watch --import tsx/esm <root>/src/server/index.ts`
// against a source tree that was never packed — the daemon process exits
// immediately, every readiness poll fails, and the only symptom is an opaque
// "Daemon startup timeout" after the full wait window. Stripping the flag
// keeps this smoke pinned to the same dist-mode spawn a real npm install uses.
export function buildTarballSmokeChildEnv(processEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { WHITEBOARD_DEV: _unused, ...rest } = processEnv
  return rest
}

function listTarballEntries(tarballPath: string): string[] {
  const result = spawnSync('tar', ['-tzf', tarballPath], { encoding: 'utf-8' })
  if (result.status !== 0) {
    throw new Error(`[tarball-smoke] tar -tzf failed: ${(result.stderr as string)?.trim()}`)
  }
  return (result.stdout as string).split('\n').filter(Boolean)
}

export async function runPackedTarballSmoke({
  packageRoot,
  repoRoot,
}: RunPackedTarballSmokeOptions): Promise<void> {
  const installDir = mkdtempSync(join(tmpdir(), 'whiteboard-tarball-install-'))
  const npmCacheDir = mkdtempSync(join(tmpdir(), 'whiteboard-npm-cache-'))
  let packedTarballPath: string | null = null

  const cleanup = () => {
    rmSync(installDir, { recursive: true, force: true })
    rmSync(npmCacheDir, { recursive: true, force: true })
    if (packedTarballPath) rmSync(packedTarballPath, { force: true })
  }

  // Ensures cleanup runs even when process.exit() is called externally (e.g. SIGINT).
  process.once('exit', cleanup)

  try {
    const env = { ...process.env, npm_config_cache: npmCacheDir } as NodeJS.ProcessEnv

    // pnpm pack resolves catalog: protocol entries to concrete versions before
    // packing. npm pack would ship "loro-crdt: catalog:" verbatim, making the
    // tarball uninstallable outside a pnpm workspace.
    const packResult = spawnSync('pnpm', ['pack'], {
      cwd: packageRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    })
    if (packResult.status !== 0) {
      const stderr = (packResult.stderr as string)?.trim()
      const stdout = (packResult.stdout as string)?.trim()
      throw new Error(
        `[tarball-smoke] pnpm pack exited with ${packResult.status ?? 'null'}${
          stderr ? `\n${stderr}` : stdout ? `\n${stdout}` : ''
        }`,
      )
    }

    // pnpm pack prints the tarball path as the last non-empty line of stdout.
    const packedTarball = (packResult.stdout as string)
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .pop()
    if (!packedTarball) {
      throw new Error(
        `[tarball-smoke] pnpm pack did not return a filename: ${packResult.stdout as string}`,
      )
    }

    packedTarballPath = resolve(packageRoot, packedTarball)
    if (!existsSync(packedTarballPath)) {
      throw new Error(`[tarball-smoke] packed tarball was not created: ${packedTarballPath}`)
    }

    assertTarballFileList(listTarballEntries(packedTarballPath))

    writeFileSync(
      resolve(installDir, 'package.json'),
      JSON.stringify({ name: 'whiteboard-tarball-smoke', private: true }, null, 2),
    )

    console.log(`[tarball-smoke] pack → ${packedTarballPath}`)
    console.log(`[tarball-smoke] install dir → ${installDir}`)

    // --ignore-scripts: this installs into a disposable scratch directory to
    // check that the packed tarball's entrypoint runs, not to exercise any
    // dependency's native build step. Without it, pnpm 11's default-deny
    // build-script policy makes `pnpm add` exit non-zero (ERR_PNPM_IGNORED_BUILDS)
    // whenever a transitive dependency ships an ignored postinstall script
    // (e.g. protobufjs) — a real behavior change from pnpm 10, where the same
    // situation was only a warning.
    spawnChecked(
      'pnpm',
      [
        'add',
        '--prefer-offline',
        '--package-import-method=copy',
        '--ignore-scripts',
        packedTarballPath,
      ],
      { cwd: installDir, env },
    )

    const installedPackageRoot = resolve(installDir, 'node_modules/@kamiazya/whiteboard-mcp')
    const installedEntry = resolve(installedPackageRoot, 'dist/server/mcp/index.js')
    const installedBin = resolve(
      installDir,
      process.platform === 'win32'
        ? 'node_modules/.bin/whiteboard.cmd'
        : 'node_modules/.bin/whiteboard',
    )

    if (!existsSync(installedPackageRoot)) {
      throw new Error(`[tarball-smoke] package was not installed: ${installedPackageRoot}`)
    }
    if (!existsSync(installedEntry)) {
      throw new Error(`[tarball-smoke] installed entrypoint missing: ${installedEntry}`)
    }
    if (!existsSync(installedBin)) {
      throw new Error(`[tarball-smoke] installed bin missing: ${installedBin}`)
    }

    console.log(`[tarball-smoke] installed package → ${installedPackageRoot}`)
    console.log(`[tarball-smoke] installed entry → ${installedEntry}`)

    // The tarball smoke runs as a standalone node script (no vitest
    // testTimeout ceiling), so it can afford bounded retry across multiple
    // daemon cold-start windows under CI contention.
    await runE2eCheckpointSmoke({
      entry: installedEntry,
      root: repoRoot,
      retryDaemonStartup: true,
      env: buildTarballSmokeChildEnv(process.env),
    })

    console.log('[tarball-smoke] installed tarball entrypoint OK')
  } finally {
    process.removeListener('exit', cleanup)
    cleanup()
  }
}
