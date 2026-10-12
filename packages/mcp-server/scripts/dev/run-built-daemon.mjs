#!/usr/bin/env node
import { spawn } from 'node:child_process'
// The BUILT-artifact variant of `pnpm mcp:http:dev`: runs dist/ instead of
// watch-mode source, for checking the daemon as it ships. Without
// `pnpm build` first the bare `node dist/...` fails with a MODULE_NOT_FOUND
// that names no cause, so the prerequisite is checked and said out loud.
//
// Built or not, it is a DEV daemon, so it keeps the checkout's `.dev-data`
// exactly as `mcp:http:dev` does — the installed release's `~/.whiteboard`
// is no place for a build of unreleased migrations.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ensureDevDataDirSecured,
  resolveDevDataDirEnv,
  resolveRepoRootFromGit,
} from './with-dev-data-dir-lib.mjs'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')
const entry = join(packageRoot, 'dist/server/daemon-entry.js')
if (!existsSync(entry)) {
  process.stderr.write(
    '[mcp:http] dist/server/daemon-entry.js is missing — this script runs the BUILT daemon; run `pnpm build` first (or use `pnpm mcp:http:dev` for watch-mode source).\n',
  )
  process.exit(1)
}

// A build older than the source is refused by name. The source dev daemon
// migrates `.dev-data` to the newest migration, and a build without it then
// stops with an "upgrade to the latest release" error — while the release may
// not ship that migration yet either. The newest name is the one to check:
// kysely runs migrations in name order, so it is the last one any build gains.
const registry = join(packageRoot, 'src/server/store/db/migrations/index.ts')
if (existsSync(registry)) {
  const names = [...readFileSync(registry, 'utf8').matchAll(/'(\d{4}-[a-z0-9-]+)':/g)].map(
    (m) => m[1],
  )
  const newest = names.toSorted().at(-1)
  if (newest && !builtFilesShip(join(packageRoot, 'dist'), newest)) {
    process.stderr.write(
      `[mcp:http] dist/ is older than this checkout's source: it does not ship migration ${newest}. Run \`pnpm build\` first (or use \`pnpm mcp:http:dev\` for watch-mode source).\n`,
    )
    process.exit(1)
  }
}

/** Whether any built `.js` under `dir` names `text`; the served web app and widget are not the server. */
function builtFilesShip(dir, text) {
  return readdirSync(dir, { withFileTypes: true, recursive: true }).some((entry) => {
    const path = join(entry.parentPath, entry.name)
    return (
      entry.isFile() &&
      entry.name.endsWith('.js') &&
      !/^(web-app|widget)[\\/]/.test(relative(dir, path)) &&
      readFileSync(path, 'utf8').includes(text)
    )
  })
}

const hadExplicitDataDirOverride = Boolean(process.env.WHITEBOARD_DATA_DIR)
const env = resolveDevDataDirEnv(process.env, resolveRepoRootFromGit(packageRoot))
if (!hadExplicitDataDirOverride) ensureDevDataDirSecured(env.WHITEBOARD_DATA_DIR)
const child = spawn(process.execPath, [entry, '--token=whiteboard-dev'], { stdio: 'inherit', env })
child.on('exit', (code) => process.exit(code ?? 1))
