// A composite root script names other scripts by string, and pnpm only finds
// out at the moment it runs one.
//
// `pnpm smoke:template` sat inside `test:e2e:distribution:only` — and so
// inside `check:release-candidate` — for long enough that the package script
// it delegated to had been deleted. The whole template feature was gone:
// `template_list`/`template_insert` are registered nowhere. Running the
// release-candidate gate answered
// `ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT: None of the selected packages has a
// "smoke:template" script`, at the eighth of fifteen steps, so everything
// after it never ran either.
//
// Nothing could have noticed. A dangling name typechecks, lints, and is
// invisible to every test that does not execute the whole chain — which is
// exactly the chain nobody runs except at a release.

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
// __dirname -> packages/mcp-server/src/server/release
const REPO_ROOT = resolve(__dirname, '../../../../..')

interface PackageJson {
  scripts?: Record<string, string>
}

function readScripts(path: string): Record<string, string> {
  return (JSON.parse(readFileSync(resolve(REPO_ROOT, path), 'utf-8')) as PackageJson).scripts ?? {}
}

const rootScripts = readScripts('package.json')

/**
 * pnpm's own subcommands, which look exactly like a script name after `pnpm`
 * and resolve without one.
 *
 * An allowlist rather than a full list of pnpm's CLI: only what these scripts
 * actually reach for. A built-in that arrives later shows up as a dangling
 * name and gets added here deliberately, which is the safer direction — the
 * opposite mistake is a guard that quietly stops checking.
 */
const PNPM_BUILTINS = new Set(['audit', 'exec', 'run', 'install', 'dlx'])

/**
 * Every `pnpm <name>` a root script delegates to.
 *
 * Only the bare form: `pnpm --filter <pkg> <name>` names a script in another
 * package, which this file cannot resolve, and guessing at it would trade a
 * real check for a flaky one.
 */
function delegatedScriptNames(command: string): string[] {
  return [...command.matchAll(/(?:^|&&|\|\|)\s*pnpm\s+([a-z][\w:-]*)/g)]
    .map((match) => match[1])
    .filter((name): name is string => name !== undefined && !PNPM_BUILTINS.has(name))
}

describe('root composite scripts', () => {
  it('delegate only to scripts that exist', () => {
    const dangling: string[] = []
    for (const [name, command] of Object.entries(rootScripts)) {
      for (const delegate of delegatedScriptNames(command)) {
        if (rootScripts[delegate] === undefined) dangling.push(`${name} -> pnpm ${delegate}`)
      }
    }
    expect(dangling).toEqual([])
  })

  /**
   * The scan reached its subject. A pattern that stopped matching would
   * report every chain as clean, which is the failure this whole file is
   * about arriving one level up.
   */
  it('actually found the delegations it is checking', () => {
    const found = Object.values(rootScripts).flatMap(delegatedScriptNames)
    expect(found.length).toBeGreaterThan(20)
    expect(found).toContain('typecheck')
  })
})
