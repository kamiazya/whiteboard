/**
 * A push from a tree that is behind its lockfile, or behind a workspace
 * package's version, fails once, naming the fix,
 * instead of installing into itself from every pre-push command at once.
 *
 * pnpm 11 checks the installed tree before each `run`/`exec` (the `pnpm
 * vitest` fallback included) and, by default, answers a stale one by running
 * `pnpm install` — synchronous, unlocked, progress on stdout. Pre-push runs its
 * pnpm commands in parallel, so after a clean merge that moved the lockfile or bumped a package version
 * (release-please does the latter)
 * each of them installed into the same tree, and the root `prepare` rewrote the
 * git hooks while the hook was running. Measured on a toy workspace: five
 * concurrent `pnpm exec` calls printed five `Packages: +2 … Done` blocks. The
 * push failed in ways that named nothing (a JSON parse error, a module missing
 * mid-relink) and the retry passed, because the failed run had installed.
 *
 * `pnpm_config_verify_deps_before_run=error` turns that into
 * `ERR_PNPM_VERIFY_DEPS_BEFORE_RUN … Run "pnpm install"` and exit 1, and on a
 * current tree changes nothing. Read from that exact spelling: pnpm 11.12's
 * config reader assigns it directly, and `npm_config_verify_deps_before_run`
 * was measured to be ignored (the toy installed and ran). Scoped to the hook,
 * so `pnpm run` at a prompt keeps installing for whoever types it.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { REPO_ROOT } from './scan-roots.js'

interface LefthookCommand {
  run?: string
  env?: Record<string, string>
}

function prePushCommands(): Array<[string, LefthookCommand]> {
  const config = parse(readFileSync(join(REPO_ROOT, 'lefthook.yml'), 'utf8')) as {
    'pre-push'?: { commands?: Record<string, LefthookCommand> }
  }
  return Object.entries(config['pre-push']?.commands ?? {})
}

describe('pre-push refuses a tree behind its lockfile rather than installing', () => {
  it('reads the pre-push commands', () => {
    expect(prePushCommands().length).toBeGreaterThanOrEqual(5)
  })

  it('every pre-push command that starts pnpm fails fast on a stale tree', () => {
    const pnpmCommands = prePushCommands().filter(([, command]) =>
      /^pnpm\b/.test(command.run ?? ''),
    )
    expect(pnpmCommands.length).toBeGreaterThanOrEqual(5)
    const installing = pnpmCommands
      .filter(([, command]) => command.env?.pnpm_config_verify_deps_before_run !== 'error')
      .map(([name]) => name)
    expect(installing, 'set env pnpm_config_verify_deps_before_run: error').toEqual([])
  })
})
